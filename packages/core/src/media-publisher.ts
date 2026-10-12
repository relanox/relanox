import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChannelMediaHost, StateNamespace, Storage } from '@relanox/sdk'
import { validatePublicUrl } from '@relanox/sdk'
import type { Hono } from 'hono'
import { z } from 'zod'
import { textId } from './validation.js'
import { CoreError } from './errors.js'
import { mediaId, verifiedMedia } from './media.js'
import type { MediaPublisherOptions } from './types.js'

const ticketSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.number().int().positive()
})

const namespace = (accountId: string): StateNamespace => ({
  pluginId: 'core-media-publisher',
  ownerId: accountId
})

const keyFor = (channelId: string, id: string): string => `${channelId}/${id}`

export function validateMediaOptions(input: unknown): MediaPublisherOptions {
  const options = z
    .strictObject({
      urlLifetimeMs: z.number().int().positive().max(604_800_000).optional()
    })
    .parse(input)

  return options.urlLifetimeMs === undefined
    ? {}
    : { urlLifetimeMs: options.urlLifetimeMs }
}

export function createMediaPublisher(
  storage: Storage,
  app: Hono,
  publicUrl: string | undefined,
  options: MediaPublisherOptions | undefined,
  maximum: number
): ((accountId: string) => ChannelMediaHost) | undefined {
  const valid = validateMediaOptions(options ?? {})
  if (publicUrl === undefined) {
    return undefined
  }
  const origin = validatePublicUrl(publicUrl)

  const lifetime = z
    .number()
    .int()
    .positive()
    .max(604_800_000)
    .parse(valid.urlLifetimeMs ?? 86_400_000)

  app.get('/media/:accountId/:channelId/:mediaId', async (context) => {
    const { accountId, channelId, mediaId: id } = context.req.param()
    if (
      !textId.safeParse(channelId).success ||
      !mediaId.safeParse(id).success
    ) {
      return new Response(null, { status: 404 })
    }

    const entry = await storage.getState(
      namespace(accountId),
      keyFor(channelId, id)
    )

    const ticket = ticketSchema.safeParse(entry?.value)
    const token = context.req.query('token') ?? ''
    if (
      !ticket.success ||
      ticket.data.expiresAt <= Date.now() ||
      !validToken(token, ticket.data.token)
    ) {
      return new Response(null, { status: 404 })
    }

    const request = await storage.getConversation(channelId, {
      includeInactive: true
    })

    const stored = await storage.media?.get(channelId, id)
    if (!stored || request?.address.accountId !== accountId) {
      return new Response(null, { status: 404 })
    }
    const media = verifiedMedia(stored, stored.reference, maximum)
    return new Response(new Uint8Array(media.data), {
      headers: {
        'content-type': media.reference.mimeType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(media.reference.fileName)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': String(media.data.byteLength)
      }
    })
  })
  return (accountId) => ({
    async publish(input) {
      textId.parse(input.channelId)
      mediaId.parse(input.mediaId)

      const request = await storage.getConversation(input.channelId, {
        includeInactive: true
      })

      if (request?.address.accountId !== accountId) {
        throw new CoreError('account_scope_mismatch')
      }
      const asset = await storage.media?.get(input.channelId, input.mediaId)
      if (!asset) {
        throw new CoreError('media_not_found')
      }
      verifiedMedia(asset, asset.reference, maximum)
      const scope = namespace(accountId)

      const expired = await storage.listState(scope, {
        expiresBefore: Date.now(),
        limit: 64
      })

      for (const entry of expired) {
        await storage.deleteState(scope, entry.key, entry.version)
      }
      const key = keyFor(input.channelId, input.mediaId)
      for (let attempt = 0; attempt < 8; attempt++) {
        const entry = await storage.getState(scope, key)
        const existing = ticketSchema.safeParse(entry?.value)
        if (existing.success && existing.data.expiresAt > Date.now()) {
          return ticketUrl(origin, accountId, input, existing.data.token)
        }

        const ticket = {
          token: randomBytes(32).toString('hex'),
          expiresAt: Date.now() + lifetime
        }

        const result = await storage.compareAndSetState(scope, {
          key,
          expectedVersion: entry?.version ?? null,
          value: ticket,
          expiresAt: ticket.expiresAt
        })

        if (result.status === 'updated') {
          return ticketUrl(origin, accountId, input, ticket.token)
        }
      }
      throw new CoreError('media_publish_conflict')
    }
  })
}

function validToken(candidate: string, expected: string): boolean {
  const bytes = Buffer.from(candidate)
  const known = Buffer.from(expected)
  return bytes.length === known.length && timingSafeEqual(bytes, known)
}

function ticketUrl(
  origin: string,
  account: string,
  input: { channelId: string; mediaId: string },
  token: string
): string {
  return `${origin}/media/${encodeURIComponent(account)}/${input.channelId}/${input.mediaId}?token=${token}`
}
