import { listenPeer } from '../../../tests/listen.js'
import { vi } from 'vitest'
import { createCore } from '../../../packages/core/src/index.js'
import type {
  CoreRuntime,
  WorkerOptions
} from '../../../packages/core/src/index.js'
import { noopObservability } from '@relanox/sdk'
import type { Storage } from '@relanox/sdk'
import { createTelegramChannel } from '../src/index.js'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { redirectRoutine } from '../../agent-grok/tests/routine-peer.js'
import {
  closeServer,
  createListeners
} from '../../../apps/cli/src/listeners.js'
import { mediaPeer } from './media-peer.js'
import { ingressStorage } from './ingress-storage.js'

type Cleanup = () => Promise<void>

export async function ingressFixture(
  cleanups: Cleanup[],
  apiBaseUrl: string,
  worker: WorkerOptions
): Promise<{
  routine: Awaited<ReturnType<typeof mediaPeer>>
  start(this: void): Promise<{
    core: CoreRuntime
    origin: string
    storage: Storage
    stop(this: void): Promise<void>
  }>
}> {
  const database = await ingressStorage(cleanups)
  const filename = database.filename
  const routine = await mediaPeer(() => ({ json: {} }))
  cleanups.push(routine.close)
  redirectRoutine(routine.origin)
  vi.stubEnv('TELEGRAM_INGRESS_AGENT', 'test-agent-token')
  vi.stubEnv('TELEGRAM_INGRESS_ROUTINE', 'https://routine.test/routine')
  vi.stubEnv('TELEGRAM_INGRESS_AUTH', 'Bearer test-routine-token')

  const start = async (): Promise<{
    core: CoreRuntime
    origin: string
    storage: Storage
    stop(this: void): Promise<void>
  }> => {
    const storage = await database.open()

    const channel = createTelegramChannel({
      TOKEN: '123:abc',
      SECRET: 'secret'
    })

    const agent = createGrokAgentPlugin()

    const core = await createCore({
      publicUrl: 'https://relay.example',
      storage,
      worker,
      channels: new Map([['telegram', channel]]),
      agents: new Map([['grok', agent]]),
      config: {
        accounts: [
          {
            id: 'telegram',
            channel: 'telegram',
            allowedSenders: ['42'],
            config: {
              botToken: { env: 'TOKEN' },
              webhookSecret: { env: 'SECRET' },
              apiBaseUrl,
              allowInsecureLoopback: true
            }
          }
        ],
        endpoints: [
          {
            id: 'agent',
            agent: 'grok',
            config: {
              mcp: { token: { env: 'TELEGRAM_INGRESS_AGENT' } },
              routineUrl: { env: 'TELEGRAM_INGRESS_ROUTINE' },
              routineAuthorization: { env: 'TELEGRAM_INGRESS_AUTH' }
            }
          }
        ],
        bindings: [
          {
            accountId: 'telegram',
            chatId: '-1007',
            threadId: '8',
            endpointId: 'agent'
          }
        ],
        storage: { plugin: 'sqlite', config: { filename } },
        observability: { plugin: 'none', config: {} }
      }
    })

    const listeners = createListeners(
      core,
      {
        observe: noopObservability,
        async flush() {},
        async shutdown() {}
      },
      () => true,
      () => true
    )

    const origin = await listenPeer(listeners.business)
    let stopped = false

    const stop = async (): Promise<void> => {
      if (stopped) {
        return
      }
      stopped = true
      await closeServer(listeners.business)
      await agent.stop?.()
      await storage.close()
    }

    cleanups.push(stop)
    return { core, origin, storage, stop }
  }

  return { start, routine }
}

// Native Update/Message/Document shapes: https://core.telegram.org/bots/api#update,
// #message and #document. File size is optional; getFile can supply it later.
export async function webhook(
  origin: string,
  updateId: number,
  document?: { file_size?: number }
): Promise<Response> {
  return fetch(`${origin}/channels/telegram/webhook`, {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'secret' },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        message_thread_id: 8,
        date: 1_760_000_000,
        from: { id: 42, is_bot: false, first_name: 'User' },
        chat: { id: -1007, type: 'supergroup', title: 'Documents' },
        ...(document
          ? {
              document: {
                file_id: 'native-document',
                file_unique_id: 'document-unique',
                file_name: 'report.pdf',
                mime_type: 'application/pdf',
                ...document
              }
            }
          : { text: 'later text' })
      }
    })
  })
}
