import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { createCore } from '@relanox/core'
import type { ChannelPlugin, Json, MediaUpload } from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { vi } from 'vitest'
import { z } from 'zod'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { cleanup, databaseFile, httpPeer } from './harness.js'

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
) {
  const storage = createSqliteStorage({
    filename: await databaseFile(),
    busyTimeoutMs: 5000
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
  vi.stubEnv('OPEN_MEDIA_ROUTINE', `${business.base}/routine`)
  vi.stubEnv('OPEN_MEDIA_ROUTINE_AUTH', 'Bearer routine-secret')
  const agent = createGrokAgentPlugin()
  cleanup(async () => agent.stop?.())

  const runtime = await createCore({
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
          dispatchMode: 'pull',
          config: {
            mcp: {
              token: { env: 'OPEN_MEDIA_MCP_TOKEN' },
              allowedHosts: [new URL(business.base).host]
            },
            routineUrl: { env: 'OPEN_MEDIA_ROUTINE' },
            routineAuthorization: { env: 'OPEN_MEDIA_ROUTINE_AUTH' },
            routineTransport: 'loopback-http'
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

  async function turn(requestId: string, uploads?: readonly MediaUpload[]) {
    const claim = z
      .object({
        status: z.literal('claimed'),
        claimToken: z.string(),
        request: z.object({ attachments: z.array(referenceSchema) })
      })
      .parse(
        (
          await client.callTool({
            name: 'relanox_claim',
            arguments: { requestId, claimKey: `claim:${requestId}` }
          })
        ).structuredContent
      )

    const inbound = []
    for (const reference of claim.request.attachments) {
      const transferred = z.object({ url: z.string() }).parse(
        (
          await client.callTool({
            name: 'relanox_media_transfer',
            arguments: {
              requestId,
              claimToken: claim.claimToken,
              mediaId: reference.id,
              method: 'GET'
            }
          })
        ).structuredContent
      )

      const response = await fetch(transferred.url)
      if (!response.ok) {
        throw new Error('Media download failed')
      }
      inbound.push({
        reference,
        data: new Uint8Array(await response.arrayBuffer())
      })
    }
    const ids = []
    for (const upload of uploads ?? []) {
      const { data, ...metadata } = upload
      const id = crypto.randomUUID()

      const transferred = z.object({ url: z.string() }).parse(
        (
          await client.callTool({
            name: 'relanox_media_transfer',
            arguments: {
              requestId,
              claimToken: claim.claimToken,
              mediaId: id,
              method: 'PUT',
              metadata
            }
          })
        ).structuredContent
      )

      const response = await fetch(transferred.url, {
        method: 'PUT',
        body: new Uint8Array(data)
      })

      const stored = z
        .object({ status: z.literal('stored'), media: referenceSchema })
        .parse(await response.json())

      ids.push(stored.media.id)
    }

    const completed = z
      .object({ status: z.literal('completed'), deliveryId: z.string() })
      .parse(
        (
          await client.callTool({
            name: 'relanox_complete',
            arguments: {
              requestId,
              claimToken: claim.claimToken,
              resultId: `result:${requestId}`,
              text: '',
              attachments: uploads
                ? ids
                : inbound.map((item) => item.reference.id)
            }
          })
        ).structuredContent
      )

    return { inbound, deliveryId: completed.deliveryId }
  }

  return { storage, runtime, businessUrl: business.base, client, turn }
}
