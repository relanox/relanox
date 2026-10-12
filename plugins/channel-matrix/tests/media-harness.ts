import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { createCore } from '@relanox/core'
import type {
  ChannelPlugin,
  Json,
  MediaUpload,
  ScopedAgentHost
} from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { vi } from 'vitest'
import { z } from 'zod'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { redirectRoutine } from '../../agent-grok/tests/routine-peer.js'
import { cleanup, databaseFile, httpPeer } from './harness.js'
import { readMedia } from '../../channel-telegram/tests/media-tools.js'

const referenceSchema = z.object({
  id: z.string(),
  kind: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
  durationMs: z.number().optional()
})

export async function mediaRelay(
  plugin: ChannelPlugin<unknown>,
  config: Json,
  chats: readonly { chatId: string; threadId?: string }[],
  allowedSenders: readonly string[],
  maxMediaBytes = 1024
): Promise<{
  storage: ReturnType<typeof createSqliteStorage>
  runtime: Awaited<ReturnType<typeof createCore>>
  businessUrl: string
  client: Client
  turn(
    this: void,
    requestId: string,
    uploads?: readonly MediaUpload[]
  ): Promise<{
    inbound: {
      reference: {
        id: string
        kind: string
        mimeType: string
        fileName: string
        durationMs?: number | undefined
      }
      data: Uint8Array<ArrayBuffer>
    }[]
    deliveryId: string
  }>
}> {
  const storage = createSqliteStorage({
    filename: await databaseFile()
  })

  await storage.initialize()
  cleanup(async () => storage.close())

  const business = await httpPeer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(',') : value)
      }
    }

    const result = await runtime.fetch(
      new Request(`${business.base}${request.url ?? '/'}`, {
        method: request.method ?? 'GET',
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: Buffer.concat(chunks) })
      })
    )

    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(new Uint8Array(await result.arrayBuffer()))
  })

  vi.stubEnv('OPEN_MEDIA_MCP_TOKEN', 'media-agent-secret')
  redirectRoutine(business.base)
  vi.stubEnv('OPEN_MEDIA_ROUTINE', 'https://routine.test/routine')
  vi.stubEnv('OPEN_MEDIA_ROUTINE_AUTH', 'Bearer routine-secret')
  const agent = createGrokAgentPlugin()
  let principal: ScopedAgentHost | undefined
  const setup = agent.setup.bind(agent)
  agent.setup = async (host, endpoints, pluginConfig): Promise<void> => {
    principal = host.forPrincipal({
      subject: 'worker',
      endpointIds: ['worker']
    })
    await setup(host, endpoints, pluginConfig)
  }
  cleanup(async () => agent.stop?.())

  const runtime = await createCore({
    publicUrl: business.base,
    storage,
    channels: new Map([['bot', plugin]]),
    agents: new Map([['grok', agent]]),
    worker: {
      maxMediaBytes,
      maxTotalMediaBytes: maxMediaBytes * 4,
      maxAttachments: 8
    },
    config: {
      accounts: [
        { id: 'bot', channel: plugin.channel, config, allowedSenders }
      ],
      endpoints: [
        {
          id: 'worker',
          agent: 'grok',
          config: {
            mcp: {
              token: { env: 'OPEN_MEDIA_MCP_TOKEN' }
            },
            routineUrl: { env: 'OPEN_MEDIA_ROUTINE' },
            routineAuthorization: { env: 'OPEN_MEDIA_ROUTINE_AUTH' }
          }
        }
      ],
      bindings: chats.map((chat) => ({
        accountId: 'bot',
        endpointId: 'worker',
        ...chat
      })),
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  cleanup(async () => plugin.stop?.())

  const client = new Client(
    { name: 'native-media-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  )

  cleanup(async () => client.close())
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${business.base}/agents/grok/mcp/worker`),
      {
        requestInit: { headers: { Authorization: 'Bearer media-agent-secret' } }
      }
    )
  )

  async function turn(
    requestId: string,
    uploads?: readonly MediaUpload[]
  ): Promise<{
    inbound: {
      reference: {
        id: string
        kind: string
        mimeType: string
        fileName: string
        durationMs?: number | undefined
      }
      data: Uint8Array<ArrayBuffer>
    }[]
    deliveryId: string
  }> {
    const request = await storage.getInbound(requestId)
    if (!request) {
      throw new Error('missing_media_request')
    }
    const inbound = []
    for (const asset of request.snapshot.attachments ?? []) {
      const reference = referenceSchema.parse(asset)
      inbound.push({
        reference,
        data: await readMedia(client, request.snapshot.channel.id, reference.id)
      })
    }
    if (uploads) {
      if (!principal) {
        throw new Error('missing_media_principal')
      }

      const reply = await principal.sendMessage({
        channel: request.snapshot.channel.id,
        text: '',
        attachments: uploads,
        idempotencyKey: `reply:${requestId}`
      })

      if (reply.status !== 'queued') {
        throw new Error('media_reply_failed')
      }
      return { inbound, deliveryId: reply.deliveryId }
    }

    const reply = z
      .object({ status: z.literal('queued'), deliveryId: z.string() })
      .parse(
        (
          await client.callTool({
            name: 'relanox_send_message',
            arguments: {
              channel: request.snapshot.channel.id,
              text: '',
              idempotencyKey: `reply:${requestId}`,
              attachments: inbound.map((item) => ({
                mediaId: item.reference.id
              }))
            }
          })
        ).structuredContent
      )

    return { inbound, deliveryId: reply.deliveryId }
  }

  return { storage, runtime, businessUrl: business.base, client, turn }
}
