import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ScopedAgentHost } from '@relanox/sdk'
import { z } from 'zod'
import type { McpConfig } from './config.js'
import { equalSecret, resolveAgentSecret } from './secrets.js'

const id = z.string().min(1).max(1024)

const ticketSchema = z.strictObject({
  endpointId: id,
  requestId: id,
  mediaId: id,
  expiresAt: z.number()
})

type Ticket = z.infer<typeof ticketSchema>

export function createMediaTransport(
  host: ScopedAgentHost,
  config: McpConfig,
  endpointId: string,
  agent: 'dot' | 'grok'
): {
  authorize(this: void, request: Request): Promise<Response | undefined>
  fetch(this: void, request: Request): Promise<Response>
  register(this: void, server: McpServer): void
  maxBytes: number
  run<T>(this: void, request: Request, operation: () => T): T
} {
  const context = new AsyncLocalStorage<string>()

  const sign = (payload: string): string =>
    createHmac('sha256', resolveAgentSecret(config.token))
      .update(`relanox-media-v1:${payload}`)
      .digest('base64url')

  function issue(ticket: Ticket): string {
    const origin = context.getStore()
    if (!origin) {
      throw new Error('media_request_origin_missing')
    }
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')

    const url = new URL(
      `/agents/${agent}/media/${encodeURIComponent(endpointId)}/${encodeURIComponent(ticket.requestId)}/${encodeURIComponent(ticket.mediaId)}`,
      origin
    )

    url.searchParams.set('ticket', `${payload}.${sign(payload)}`)
    return url.href
  }

  function decode(request: Request): Ticket | undefined {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    if (
      (request.headers.get('host') ?? url.host) !== url.host ||
      !config.allowedHosts.includes(url.host) ||
      (origin !== null && !config.allowedOrigins.includes(origin))
    ) {
      return undefined
    }
    const parts = url.searchParams.get('ticket')?.split('.')
    if (
      parts?.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !equalSecret(sign(parts[0]), parts[1])
    ) {
      return undefined
    }
    try {
      const result = ticketSchema.safeParse(
        JSON.parse(Buffer.from(parts[0], 'base64url').toString())
      )

      if (!result.success) {
        return undefined
      }
      const ticket = result.data
      const suffix = `/media/${encodeURIComponent(endpointId)}/${encodeURIComponent(ticket.requestId)}/${encodeURIComponent(ticket.mediaId)}`
      return ticket.endpointId === endpointId &&
        ticket.expiresAt > Date.now() &&
        request.method === 'GET' &&
        url.pathname.endsWith(suffix)
        ? ticket
        : undefined
    } catch {
      return undefined
    }
  }

  const authorize = async (request: Request): Promise<Response | undefined> =>
    decode(request)
      ? undefined
      : Response.json({ error: 'unauthorized' }, { status: 401 })

  async function fetch(request: Request): Promise<Response> {
    const ticket = decode(request)
    if (!ticket || !host.media) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    const stored = await host.media.read(ticket)
    if (!stored) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return new Response(new Uint8Array(stored.data), {
      headers: {
        'Content-Type': stored.reference.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(stored.reference.fileName)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  }

  function register(server: McpServer): void {
    if (!host.media) {
      return
    }
    const mediaHost = host.media
    server.registerTool(
      'relanox_read_media',
      {
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        },
        description:
          'Read media attached to the incoming message. Small image/audio assets are returned as model-visible MCP content; other assets are a binary download resource link. Client support for consuming download links must be verified separately.',
        inputSchema: z.strictObject({
          replyTo: id,
          mediaId: id
        })
      },
      async (input) => {
        const request = { requestId: input.replyTo, mediaId: input.mediaId }
        const stored = await mediaHost.read(request)
        if (!stored) {
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Media unavailable for this message.' }
            ]
          }
        }
        const { reference, data } = stored
        if (
          (reference.kind === 'image' || reference.kind === 'audio') &&
          data.byteLength <= 1_048_576
        ) {
          return {
            content: [
              {
                type: reference.kind,
                data: Buffer.from(data).toString('base64'),
                mimeType: reference.mimeType
              }
            ]
          }
        }

        const uri = issue({
          ...request,
          endpointId,
          expiresAt: Date.now() + 300_000
        })

        return {
          content: [
            {
              type: 'resource_link',
              uri,
              name: reference.fileName,
              mimeType: reference.mimeType,
              size: reference.size
            }
          ]
        }
      }
    )
  }

  return {
    authorize,
    fetch,
    register,
    maxBytes: host.media?.maxBytes ?? 0,
    run: <T>(request: Request, operation: () => T): T =>
      context.run(new URL(request.url).origin, operation)
  }
}
