import type { McpServer } from '@modelcontextprotocol/server'
import type { ScopedAgentHost } from '@relanox/sdk'
import { z } from 'zod'
import type { McpConfig } from './config.js'
import { uploadInput, uploadTickets } from './upload-ticket.js'
import type { UploadTicket } from './upload-ticket.js'

const knownError = z.object({
  code: z.enum([
    'media_conflict',
    'media_too_large',
    'media_total_too_large',
    'too_many_attachments',
    'invalid_media_preview',
    'media_storage_missing'
  ])
})

function uploadFailure(error: unknown): Response {
  const parsed = knownError.safeParse(error)
  if (!parsed.success) {
    return Response.json({ error: 'upload_failed' }, { status: 500 })
  }
  const code = parsed.data.code

  const statuses = {
    media_conflict: 409,
    media_too_large: 413,
    media_total_too_large: 413,
    too_many_attachments: 413,
    invalid_media_preview: 400,
    media_storage_missing: 503
  }

  return Response.json({ error: code }, { status: statuses[code] })
}

function checkHeaders(
  request: Request,
  ticket: UploadTicket
): Response | undefined {
  if (
    request.headers.get('content-type')?.toLowerCase() !==
    ticket.mimeType.toLowerCase()
  ) {
    return Response.json({ error: 'invalid_content_type' }, { status: 415 })
  }
  const length = request.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d+$/u.test(length) || Number(length) !== ticket.size)
  ) {
    return Response.json({ error: 'upload_size_mismatch' }, { status: 400 })
  }
  return undefined
}

export function createUploadTransport(
  host: ScopedAgentHost,
  config: McpConfig,
  endpointId: string,
  agent: 'dot' | 'grok',
  origin: string
): {
  matches(this: void, request: Request): boolean
  authorize(this: void, request: Request): Promise<Response | undefined>
  fetch(this: void, request: Request): Promise<Response>
  register(this: void, server: McpServer): void
} {
  const tickets = uploadTickets(config, endpointId, agent, origin)
  const media = host.media
  const maximum = media ? Math.min(media.maxBytes, media.maxTotalBytes) : 0

  async function authorize(request: Request): Promise<Response | undefined> {
    const ticket = tickets.decode(request)
    if (!ticket || !media) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (ticket.size > maximum) {
      return Response.json({ error: 'media_too_large' }, { status: 413 })
    }
    const rejected = checkHeaders(request, ticket)
    if (rejected) {
      return rejected
    }
    return (await media.authorize({ channelId: ticket.channelId }))
      ? undefined
      : Response.json({ error: 'not_found' }, { status: 404 })
  }

  async function fetch(request: Request): Promise<Response> {
    const rejected = await authorize(request)
    if (rejected) {
      return rejected
    }
    const ticket = tickets.decode(request)
    if (!ticket || !media) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    const data = new Uint8Array(await request.arrayBuffer())
    if (data.byteLength !== ticket.size) {
      return Response.json({ error: 'upload_size_mismatch' }, { status: 400 })
    }
    try {
      const reference = await media.upload({
        channelId: ticket.channelId,
        mediaId: ticket.mediaId,
        upload: {
          kind: ticket.kind,
          mimeType: ticket.mimeType,
          fileName: ticket.fileName,
          data,
          ...(ticket.durationMs === undefined
            ? {}
            : { durationMs: ticket.durationMs }),
          ...(ticket.previewMediaId === undefined
            ? {}
            : { previewMediaId: ticket.previewMediaId })
        }
      })

      return reference
        ? Response.json(
            { fileId: reference.id },
            { headers: { 'Cache-Control': 'no-store' } }
          )
        : Response.json({ error: 'not_found' }, { status: 404 })
    } catch (error) {
      return uploadFailure(error)
    }
  }

  function register(server: McpServer): void {
    if (!media) {
      return
    }
    server.registerTool(
      'relanox_create_upload',
      {
        description:
          'Upload a generated local file to the selected authorized channel. Copy channel unchanged, supply its exact byte size, filename, MIME type and media kind. Returns a five-minute signed uploadUrl, method and headers. Use a terminal or HTTP tool to PUT raw file bytes (not JSON, Base64 or multipart) with those headers; no MCP password is needed. A successful PUT returns fileId. Only then call relanox_send_message with attachments [{mediaId: fileId}]. Retry an interrupted PUT with the same URL and identical bytes; a different file needs a new upload. Uploading alone does not send a reply. Audio/video may need durationMs or an already uploaded same-channel image previewMediaId.',
        inputSchema: uploadInput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (input) => {
        if (
          input.size > maximum ||
          !(await media.authorize({ channelId: input.channel }))
        ) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Upload unavailable: check the authorized channel and file size.'
              }
            ]
          }
        }
        const { channel, ...metadata } = input

        const ticket = {
          ...metadata,
          channelId: channel,
          mediaId: crypto.randomUUID(),
          endpointId,
          expiresAt: Date.now() + 300_000
        }

        const result = {
          uploadUrl: tickets.issue(ticket),
          method: 'PUT',
          headers: { 'Content-Type': input.mimeType },
          expiresAt: new Date(ticket.expiresAt).toISOString()
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result
        }
      }
    )
  }

  return { matches: tickets.matches, authorize, fetch, register }
}
