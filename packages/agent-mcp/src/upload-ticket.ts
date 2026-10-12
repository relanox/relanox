import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { McpConfig } from './config.js'
import { equalSecret, resolveAgentSecret } from './secrets.js'

const id = z.string().min(1).max(1024)

const metadata = {
  kind: z.enum(['image', 'audio', 'video', 'file']),
  mimeType: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) =>
        name.isWellFormed() &&
        !/[\p{Cc}/\\]/u.test(name) &&
        name !== '.' &&
        name !== '..'
    ),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  durationMs: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  previewMediaId: z.uuid().optional()
}

function compatibleKind(value: { kind: string; mimeType: string }): boolean {
  return (
    value.kind === 'file' ||
    value.mimeType.toLowerCase().startsWith(`${value.kind}/`)
  )
}

export const uploadInput = z
  .strictObject({
    channel: id.describe(
      'An authorized channel ID from relanox_status or source.channel.id; this channel owns the uploaded file.'
    ),
    ...metadata
  })
  .refine(compatibleKind, 'MIME type must match the media kind')

const ticketSchema = z
  .strictObject({
    endpointId: id,
    channelId: id,
    mediaId: z.uuid(),
    expiresAt: z.number().int().positive(),
    ...metadata
  })
  .refine(compatibleKind)

export type UploadTicket = z.infer<typeof ticketSchema>

/** Upload capabilities have a separate signing domain from media downloads. */
export function uploadTickets(
  config: McpConfig,
  endpointId: string,
  agent: 'dot' | 'grok',
  origin: string
): {
  matches(this: void, request: Request): boolean
  issue(this: void, ticket: UploadTicket): string
  decode(this: void, request: Request): UploadTicket | undefined
} {
  const prefix = `/agents/${agent}/media/${encodeURIComponent(endpointId)}/upload/`
  const deploymentHost = new URL(origin).host

  const sign = (payload: string): string =>
    createHmac('sha256', resolveAgentSecret(config.token))
      .update(`relanox-upload-v1:${payload}`)
      .digest('base64url')

  const path = (ticket: UploadTicket): string =>
    `${prefix}${encodeURIComponent(ticket.channelId)}/${ticket.mediaId}`

  return {
    matches(request: Request): boolean {
      return new URL(request.url).pathname.startsWith(prefix)
    },
    issue(ticket: UploadTicket): string {
      const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
      const url = new URL(path(ticket), origin)
      url.searchParams.set('ticket', `${payload}.${sign(payload)}`)
      return url.href
    },
    decode(request: Request): UploadTicket | undefined {
      const url = new URL(request.url)
      const callerOrigin = request.headers.get('origin')
      if (
        request.method !== 'PUT' ||
        url.host !== deploymentHost ||
        (request.headers.get('host') ?? url.host) !== url.host ||
        (callerOrigin !== null && !config.allowedOrigins.includes(callerOrigin))
      ) {
        return undefined
      }
      const token = url.searchParams.get('ticket') ?? ''
      const parts = token.split('.')
      if (
        token.length > 8192 ||
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1] ||
        !equalSecret(sign(parts[0]), parts[1])
      ) {
        return undefined
      }
      try {
        const parsed = ticketSchema.safeParse(
          JSON.parse(Buffer.from(parts[0], 'base64url').toString())
        )

        if (!parsed.success) {
          return undefined
        }
        const ticket = parsed.data
        return ticket.endpointId === endpointId &&
          ticket.expiresAt > Date.now() &&
          url.pathname === path(ticket)
          ? ticket
          : undefined
      } catch {
        return undefined
      }
    }
  }
}
