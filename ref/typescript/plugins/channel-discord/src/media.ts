import { REQUEST_TIMEOUT_MS, API_BASE_URL } from './config.js'
import { createHash } from 'node:crypto'
import { mediaBlob } from '@relanox/channel-media'
import type { ChannelHost, SendInput } from '@relanox/sdk'
import type { DiscordConfig } from './config.js'
import { postJson } from './transport.js'
import { richComponents, richFileName } from './rich.js'

// Native bot file uploads default to 20 MiB since 2026-09-03.
// https://docs.discord.com/developers/reference#uploading-files
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

// Create Message limits the whole request to 25 MiB. Keep binary rich content
// At 20 MiB, leaving room for the bounded text, labels and multipart envelope.
// https://docs.discord.com/developers/resources/message#create-message
export const MAX_RICH_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024

export function mediaError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  if (input.chunk.richText) {
    const parts = input.chunk.richText
    const images = parts.filter((part) => part.type === 'image')
    if (
      parts.length > 10 ||
      images.length > 10 ||
      parts
        .filter((part) => part.type === 'text')
        .reduce((length, part) => length + part.text.length, 0) > 1800
    ) {
      return 'rich_message_limit_exceeded'
    }
    if (
      images.length !== (input.richMedia?.length ?? 0) ||
      images.some(
        (part, index) =>
          input.richMedia?.[index]?.reference.id !== part.media.id
      )
    ) {
      return 'missing_media'
    }
    if (
      (input.richMedia ?? []).reduce(
        (total, media) => total + media.data.byteLength,
        0
      ) > MAX_RICH_IMAGE_TOTAL_BYTES ||
      (input.richMedia ?? []).some(
        (media) =>
          media.reference.kind !== 'image' ||
          media.data.byteLength >
            Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, 10 * 1024 * 1024)
      )
    ) {
      return 'media_limit_exceeded'
    }
  }
  if (
    input.chunk.media &&
    (!input.media ||
      input.media.data.byteLength >
        Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, MAX_UPLOAD_BYTES))
  ) {
    return 'media_limit_exceeded'
  }
  return undefined
}

export async function sendMessage(
  input: SendInput,
  host: ChannelHost,
  config: DiscordConfig,
  token: string
): Promise<Response> {
  const payload = {
    ...(input.chunk.richText
      ? { flags: 32_768, components: richComponents(input) }
      : { content: input.chunk.text }),
    allowed_mentions: { parse: [], replied_user: false },
    nonce: createHash('sha256')
      .update(input.chunk.idempotencyKey)
      .digest('hex')
      .slice(0, 24),
    enforce_nonce: true,
    ...(input.reply && input.target.replyToId
      ? {
          message_reference: {
            message_id: input.target.replyToId,
            fail_if_not_exists: false
          }
        }
      : {})
  }

  const url = `${API_BASE_URL.replace(/\/$/u, '')}/channels/${input.target.threadId ?? input.target.chatId}/messages`
  const headers = { authorization: `Bot ${token}` }
  if (input.chunk.richText) {
    const body = new FormData()

    const attachments = (input.richMedia ?? []).map((media, index) => {
      const filename = richFileName(index, media.reference.fileName)
      body.set(`files[${index}]`, mediaBlob(media), filename)
      return { id: index, filename }
    })

    body.set('payload_json', JSON.stringify({ ...payload, attachments }))
    return fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      ]),
      redirect: 'error'
    })
  }
  if (!input.chunk.media) {
    return postJson(url, headers, payload, input.signal, REQUEST_TIMEOUT_MS)
  }
  const media = input.media
  if (
    !media ||
    media.data.byteLength >
      Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, MAX_UPLOAD_BYTES)
  ) {
    throw new Error('media_limit_exceeded')
  }
  const body = new FormData()
  body.set(
    'payload_json',
    JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: media.reference.fileName }]
    })
  )
  body.set('files[0]', mediaBlob(media), media.reference.fileName)
  return fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.any([
      input.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    ]),
    redirect: 'error'
  })
}
