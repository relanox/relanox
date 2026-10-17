import { resolve as resolvePath } from 'node:path'
import { MuseClient } from 'muse-client'
import { loadCredentials, saveCredentials } from 'muse-client/credentials'
import type { AgentPlugin, DispatchResult } from '@relanox/sdk'
import { projectAgentRequest, resolveAgentSecret } from '@relanox/agent-mcp'
import { configSchema } from './config.js'
import type { MuseConfig } from './config.js'

// Rotating a paired device's refresh token concurrently loses its successor.
// Serialize the entire connection and send across endpoints sharing a directory.
const activeDirectories = new Map<string, Promise<void>>()

async function connect(
  credentials: Awaited<ReturnType<typeof loadCredentials>>,
  config: MuseConfig,
  directory: string,
  signal: AbortSignal
): Promise<MuseClient> {
  signal.throwIfAborted()

  const pending = MuseClient.connect({
    credentials,
    ...(config.vmId === undefined ? {} : { vmId: config.vmId }),
    onCredentials: async (next) => saveCredentials(next, directory),
    fetch: async (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : [])
        ])
      })
  }).then((client) => {
    if (signal.aborted) {
      client.close()
      signal.throwIfAborted()
    }
    return client
  })

  let abort = (): void => {}

  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = (): void => {
      reject(new Error('muse_connect_cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })

  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function send(
  input: Parameters<AgentPlugin<MuseConfig>['dispatch']>[0],
  config: MuseConfig,
  directory: string
): Promise<DispatchResult> {
  const content = JSON.stringify({
    requestId: input.request.requestId,
    ...projectAgentRequest(input.request)
  })

  const nativeBody = JSON.stringify({
    message: content,
    output_modality: 'text',
    ...(config.sessionId === undefined ? {} : { session_id: config.sessionId })
  })

  if (Buffer.byteLength(nativeBody) > 256 * 1024 - 1024) {
    return { status: 'rejected', errorCode: 'muse_body_too_large' }
  }

  let credentials: Awaited<ReturnType<typeof loadCredentials>>
  try {
    credentials = await loadCredentials(directory)
  } catch {
    return { status: 'rejected', errorCode: 'muse_credentials_invalid' }
  }

  let client: MuseClient
  try {
    client = await connect(credentials, config, directory, input.signal)
  } catch {
    return { status: 'retryable', errorCode: 'muse_connect_failed' }
  }

  try {
    if (input.signal.aborted) {
      return { status: 'retryable', errorCode: 'muse_dispatch_cancelled' }
    }

    await client.sendMessage(content, {
      signal: input.signal,
      ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId })
    })
    return { status: 'accepted' }
  } catch {
    // Once handed to the SDK, timeout/transport failure may hide acceptance.
    // Replaying chat/stream could start a second agent turn.
    return { status: 'unknown', errorCode: 'muse_trigger_uncertain' }
  } finally {
    client.close()
  }
}

export const dispatchMuse: AgentPlugin<MuseConfig>['dispatch'] = async (
  input
) => {
  const config = configSchema.parse(input.request.endpoint.config)
  let directory: string
  try {
    directory = resolvePath(resolveAgentSecret(config.credentialsDirectory))
  } catch {
    return { status: 'rejected', errorCode: 'muse_credentials_invalid' }
  }

  const previous = activeDirectories.get(directory) ?? Promise.resolve()
  let release: () => void = () => {}

  const pending = new Promise<void>((resolve) => {
    release = resolve
  })

  activeDirectories.set(directory, pending)
  try {
    await previous
    if (input.signal.aborted) {
      return { status: 'retryable', errorCode: 'muse_dispatch_cancelled' }
    }
    return await send(input, config, directory)
  } finally {
    release()
    if (activeDirectories.get(directory) === pending) {
      activeDirectories.delete(directory)
    }
  }
}
