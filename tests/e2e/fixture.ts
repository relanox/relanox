import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { vi } from 'vitest'
import { z } from 'zod'
import type { AppConfig } from '../../apps/cli/src/config.js'
import { startRuntime, validateApp } from '../../apps/cli/src/runtime.js'
import { openStorage } from '../../apps/cli/src/storage.js'
import { availablePort, peer } from './peer.js'
import type { PeerReply, Traffic } from './peer.js'

export type Runtime = Awaited<ReturnType<typeof startRuntime>>
export type Cleanup = () => Promise<void>

export const routineSchema = z.strictObject({
  content: z.string(),
  source: z.literal('relanox'),
  sentAt: z.iso.datetime()
})

export const requestSchema = z.strictObject({
  replyTo: z.string(),
  text: z.string(),
  context: z.json(),
  source: z.strictObject({
    channel: z.literal('telegram'),
    eventId: z.string()
  })
})

export function dispatched(traffic: Traffic): {
  replyTo: string
  text: string
  context: z.core.util.JSONType
  source: { channel: 'telegram'; eventId: string }
} {
  return requestSchema.parse(
    JSON.parse(routineSchema.parse(JSON.parse(traffic.body)).content)
  )
}

export async function fixture(
  cleanups: Cleanup[],
  sendReply?: (traffic: Traffic, index: number) => PeerReply
): Promise<{
  config: ReturnType<typeof validateApp>
  routine: Awaited<ReturnType<typeof peer>>
  telegram: Awaited<ReturnType<typeof peer>>
  start(this: void, input?: AppConfig): Promise<Runtime>
  client(
    this: void,
    runtime: Runtime,
    endpointId: 'alpha' | 'beta'
  ): Promise<Client>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-e2e-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  const routine = await peer(() => ({ status: 200 }))
  cleanups.push(routine.close)

  const telegram = await peer(
    sendReply ??
      ((): { body: { ok: boolean; result: { message_id: number } } } => ({
        body: { ok: true, result: { message_id: 700 } }
      }))
  )

  cleanups.push(telegram.close)
  const port = await availablePort()
  vi.stubEnv('E2E_TELEGRAM_TOKEN', '123:telegram-secret')
  vi.stubEnv('E2E_TELEGRAM_WEBHOOK', 'webhook-secret')
  vi.stubEnv('E2E_GROK_ALPHA_TOKEN', 'alpha-secret')
  vi.stubEnv('E2E_GROK_BETA_TOKEN', 'beta-secret')
  vi.stubEnv('E2E_ROUTINE_ALPHA_URL', `${routine.origin}/alpha`)
  vi.stubEnv('E2E_ROUTINE_BETA_URL', `${routine.origin}/beta`)
  vi.stubEnv('E2E_ROUTINE_AUTH', 'Bearer routine-secret')

  const endpoint = (
    id: 'alpha' | 'beta'
  ): {
    id: 'alpha' | 'beta'
    agent: string
    config: {
      mcp: { token: { env: string }; allowedHosts: string[] }
      routineUrl: { env: string }
      routineAuthorization: { env: string }
      routineTransport: string
    }
  } => ({
    id,
    agent: 'grok',
    config: {
      mcp: {
        token: { env: `E2E_GROK_${id.toUpperCase()}_TOKEN` },
        allowedHosts: [`127.0.0.1:${port}`]
      },
      routineUrl: { env: `E2E_ROUTINE_${id.toUpperCase()}_URL` },
      routineAuthorization: { env: 'E2E_ROUTINE_AUTH' },
      routineTransport: 'loopback-http'
    }
  })

  const config = validateApp({
    relay: {
      accounts: [
        {
          id: 'bot',
          channel: 'telegram',
          allowedSenders: ['17'],
          config: {
            botToken: { env: 'E2E_TELEGRAM_TOKEN' },
            webhookSecret: { env: 'E2E_TELEGRAM_WEBHOOK' },
            apiBaseUrl: telegram.origin,
            allowInsecureLoopback: true
          }
        }
      ],
      endpoints: [endpoint('alpha'), endpoint('beta')],
      bindings: [
        { accountId: 'bot', chatId: '101', threadId: '9', endpointId: 'alpha' },
        { accountId: 'bot', chatId: '202', endpointId: 'beta' }
      ],
      storage: {
        plugin: 'sqlite',
        config: { filename: join(directory, 'relay.sqlite') }
      },
      observability: {
        plugin: 'standard',
        config: { logs: false, metrics: true, processMetrics: false }
      }
    },
    server: {
      port,
      managementPort: 0,
      workerIntervalMs: 20,
      workerStaleMs: 1000,
      startupTimeoutMs: 5000,
      shutdownTimeoutMs: 5000
    }
  })

  const storage = await openStorage(config.relay.storage)
  try {
    await storage.initialize()
  } finally {
    await storage.close()
  }

  const start = async (input: AppConfig = config): Promise<Runtime> => {
    const runtime = await startRuntime(input)
    cleanups.push(runtime.stop)
    return runtime
  }

  const client = async (
    runtime: Runtime,
    endpointId: 'alpha' | 'beta'
  ): Promise<Client> => {
    const connected = new Client(
      { name: 'relanox-wire-e2e', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )

    cleanups.push(async () => connected.close())
    // Process restarts intentionally close sockets; do not reuse an old pooled socket on the same port.
    await connected.connect(
      new StreamableHTTPClientTransport(
        new URL(`${runtime.businessUrl}/agents/grok/mcp/${endpointId}`),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${endpointId}-secret`,
              Connection: 'close'
            }
          }
        }
      )
    )
    return connected
  }

  return { config, routine, telegram, start, client }
}

export async function ingest(
  runtime: Runtime,
  eventId = 1,
  chatId = 101,
  text = '中文\nhello 🌍'
): Promise<Response> {
  return fetch(`${runtime.businessUrl}/channels/bot/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': 'webhook-secret',
      Connection: 'close'
    },
    body: JSON.stringify({
      update_id: eventId,
      message: {
        message_id: eventId + 40,
        message_thread_id: chatId === 101 ? 9 : undefined,
        chat: { id: chatId, type: 'supergroup' },
        from: { id: 17, is_bot: false },
        text
      }
    })
  })
}

export async function sendMessage(
  client: Client,
  replyTo: string,
  text = '最终 answer 🌍',
  idempotencyKey = `result-${replyTo}`
): Promise<{ status: 'queued'; deliveryId: string; replay: boolean }> {
  const result = await client.callTool({
    name: 'relanox_send_message',
    arguments: { replyTo, idempotencyKey, text }
  })

  return z
    .strictObject({
      status: z.literal('queued'),
      deliveryId: z.string(),
      replay: z.boolean()
    })
    .parse(result.structuredContent)
}
