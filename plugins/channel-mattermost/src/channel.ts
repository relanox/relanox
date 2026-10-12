import { requestTimeoutMs, reconnectDelayMs } from './constants.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { receiveFiles, uploadFile } from './media.js'
import { richError, richMarkdown } from './rich.js'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { z } from 'zod'
import { validateConfig, validateBaseUrl, platformIdSchema } from './config.js'
import type { MattermostConfig } from './config.js'
import {
  delay,
  diagnose,
  httpFailure,
  ingest,
  readJson,
  secret,
  stopTask
} from './protocol.js'
import {
  sendResponseSchema,
  postedEventSchema,
  frameSchema,
  postSchema,
  targetSchema
} from './schemas.js'

function decodeFrame(bytes: RawData): {
  event?: string | undefined
  data?: Record<string, unknown> | undefined
  seq_reply?: number | undefined
  status?: string | undefined
} {
  let buffer: Buffer
  if (Array.isArray(bytes)) {
    buffer = Buffer.concat(bytes)
  } else if (bytes instanceof ArrayBuffer) {
    buffer = Buffer.from(bytes)
  } else {
    buffer = bytes
  }
  return frameSchema.parse(JSON.parse(buffer.toString('utf8')) as unknown)
}

export function createMattermostChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ChannelPlugin<MattermostConfig> {
  let runtime:
    | {
        host: ChannelHost
        account: AccountConfig
        config: MattermostConfig
        base: string
        botUserId: string
      }
    | undefined

  let task: Promise<void> | undefined
  let controller: AbortController | undefined
  let socket: WebSocket | undefined

  function configured(): {
    host: ChannelHost
    account: AccountConfig
    config: MattermostConfig
    base: string
    botUserId: string
  } {
    if (!runtime) {
      throw new Error('not_setup')
    }
    return runtime
  }

  async function receive(
    frame: z.infer<typeof frameSchema>,
    signal: AbortSignal
  ): Promise<void> {
    const { host, account, config, base, botUserId } = configured()
    if (frame.event !== 'posted') {
      return
    }
    const encoded = postedEventSchema.parse(frame.data)
    const post = postSchema.parse(JSON.parse(encoded.post) as unknown)
    if (post.user_id === botUserId) {
      return
    }
    if (!account.allowedSenders.includes(post.user_id)) {
      diagnose(host, 'sender_not_allowed')
      return
    }
    if (post.type || (!post.message && post.file_ids.length === 0)) {
      diagnose(host, 'nontext_unsupported')
      return
    }

    const attachments = await receiveFiles(
      post.file_ids,
      host,
      config,
      base,
      `Bearer ${secret(config.token, environment)}`,
      signal
    )

    await ingest(host, {
      source: {
        channel: 'mattermost',
        accountId: account.id,
        eventId: post.id
      },
      senderId: post.user_id,
      text: post.message,
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: post.create_at,
      target: {
        channel: 'mattermost',
        accountId: account.id,
        chatId: post.channel_id,
        ...(post.root_id ? { threadId: post.root_id } : {}),
        replyToId: post.id,
        data: { serverUrl: base, botUserId }
      },
      context: null
    })
  }

  async function connect(signal: AbortSignal): Promise<void> {
    const { host, base, config } = configured()
    const url = new URL(`${base}/api/v4/websocket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = secret(config.token, environment)

    const current = new WebSocket(url, {
      handshakeTimeout: requestTimeoutMs,
      maxPayload: 2_097_152,
      followRedirects: false
    })

    socket = current
    let authenticated = false
    let queued = 0
    let pending = Promise.resolve()
    let lastPong = Date.now()

    const authTimeout = setTimeout(() => {
      diagnose(host, 'authentication_timeout')
      current.terminate()
    }, requestTimeoutMs)

    const heartbeat = setInterval(() => {
      if (current.readyState !== WebSocket.OPEN) {
        return
      }
      if (Date.now() - lastPong > 30_000) {
        current.terminate()
        return
      }
      current.ping()
    }, 10_000)

    const abort = (): void => {
      current.terminate()
    }

    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    current.on('open', () => {
      current.send(
        JSON.stringify({
          seq: 1,
          action: 'authentication_challenge',
          data: { token }
        })
      )
    })
    current.on('pong', () => {
      lastPong = Date.now()
    })

    async function processFrame(
      frame: z.infer<typeof frameSchema>
    ): Promise<void> {
      if (frame.seq_reply === 1) {
        if (frame.status !== 'OK') {
          diagnose(host, 'authentication_failed')
          current.terminate()
          return
        }
        authenticated = true
        clearTimeout(authTimeout)
        host.connection('connected')
        return
      }
      if (frame.event === 'posted' && !authenticated) {
        throw new Error('unauthenticated_event')
      }
      await receive(frame, signal)
    }

    current.on('message', (bytes, isBinary) => {
      if (isBinary || queued >= 100) {
        diagnose(host, 'invalid_frame')
        current.terminate()
        return
      }
      queued += 1
      pending = pending
        .then(async () => processFrame(decodeFrame(bytes)))
        .catch(() => {
          diagnose(host, 'receive_failed')
          host.connection('degraded')
          current.terminate()
        })
        .finally(() => {
          queued -= 1
        })
    })
    await new Promise<void>((resolve) => {
      current.once('close', () => {
        resolve()
      })
      current.on('error', () => {
        current.terminate()
        resolve()
      })
    })
    clearTimeout(authTimeout)
    clearInterval(heartbeat)
    signal.removeEventListener('abort', abort)
    await pending
    host.connection('disconnected')
  }

  async function loop(signal: AbortSignal): Promise<void> {
    const { host } = configured()
    while (!signal.aborted) {
      try {
        await connect(signal)
      } catch {
        host.connection('degraded')
        diagnose(host, 'connection_failed')
      }
      await delay(reconnectDelayMs, signal)
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, config, base, botUserId, host } = configured()
    const destination = targetSchema.safeParse(input.target.data)
    if (
      input.target.channel !== 'mattermost' ||
      input.target.accountId !== account.id ||
      !destination.success ||
      destination.data.serverUrl !== base ||
      destination.data.botUserId !== botUserId
    ) {
      return { status: 'rejected', errorCode: 'target_mismatch' }
    }
    const errorCode = richError(input, host)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }

    const message = input.chunk.richText
      ? await richMarkdown(input, host).catch(() => ({
          status: 'retryable' as const,
          errorCode: 'media_publication_failed'
        }))
      : input.chunk.text

    if (typeof message !== 'string') {
      return message
    }
    try {
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(requestTimeoutMs)
      ])

      const authorization = `Bearer ${secret(config.token, environment)}`

      const upload = input.media
        ? await uploadFile(input, base, authorization, signal)
        : undefined

      if (upload && !('fileId' in upload)) {
        return upload
      }

      const response = await fetch(`${base}/api/v4/posts`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel_id: input.target.chatId,
          message,
          ...(upload && 'fileId' in upload
            ? { file_ids: [upload.fileId] }
            : {}),
          ...(input.target.threadId ? { root_id: input.target.threadId } : {})
        })
      })

      if (!response.ok) {
        await response.body?.cancel()
        return httpFailure(response)
      }
      const post = sendResponseSchema.parse(await readJson(response))
      return { status: 'sent', receipt: { platformMessageId: post.id } }
    } catch {
      return { status: 'unknown', errorCode: 'send_outcome_unknown' }
    }
  }

  return {
    id: 'channel-mattermost',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'mattermost',
    get capabilities(): ChannelPlugin<MattermostConfig>['capabilities'] {
      return {
        receive: true,
        transport: 'connection',
        maxTextLength: 16_000,
        lengthUnit: 'codepoint',
        idempotentSend: false,
        ...(runtime?.host.publicUrl && runtime.host.media
          ? {
              richText: {
                maxParts: 20,
                maxTextLength: 8000,
                maxImageBytes: runtime.host.maxMediaBytes ?? 16_777_216
              }
            }
          : {}),
        media: {
          receive: ['image', 'audio', 'video', 'file'],
          send: ['image', 'audio', 'video', 'file']
        }
      }
    },
    validateConfig,
    async resolveChannel(address) {
      const current = configured()
      if (
        address.platform !== 'mattermost' ||
        address.accountId !== current.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        (address.threadId !== undefined &&
          !platformIdSchema.safeParse(address.threadId).success)
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      return {
        status: 'available',
        target: {
          channel: 'mattermost',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          data: { serverUrl: current.base, botUserId: current.botUserId }
        }
      }
    },

    async setup(host, account, config) {
      if (runtime) {
        throw new Error('already_setup')
      }

      const base = validateBaseUrl(
        config.serverUrl,
        config.allowInsecureLocalhost
      )

      const response = await fetch(`${base}/api/v4/users/me`, {
        headers: {
          Authorization: `Bearer ${secret(config.token, environment)}`
        },
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs)
      })

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('identity_discovery_failed')
      }

      const identity = z
        .object({ id: platformIdSchema })
        .parse(await readJson(response))

      runtime = {
        host,
        account,
        config,
        base,
        botUserId: identity.id
      }
    },
    async start(signal) {
      if (task) {
        return
      }
      configured()
      controller = new AbortController()
      task = loop(AbortSignal.any([signal, controller.signal])).finally(() => {
        task = undefined
      })
    },
    async stop() {
      controller?.abort()
      socket?.terminate()
      runtime?.host.connection('disconnected')
      await stopTask(task)
    },
    send
  }
}
