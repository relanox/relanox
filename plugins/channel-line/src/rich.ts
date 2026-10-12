import { markdownText } from '@relanox/markdown'
import type { ChannelHost, Json, SendInput } from '@relanox/sdk'
import { lineContents } from './markdown.js'

export function richError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }
  if (!host.publicUrl || !host.media) {
    return 'public_media_unavailable'
  }
  if (
    parts.length > 20 ||
    parts
      .filter((part) => part.type === 'text')
      .reduce((length, part) => length + part.text.length, 0) > 2000
  ) {
    return 'rich_message_limit_exceeded'
  }
  const images = parts.filter((part) => part.type === 'image')
  if (
    images.length !== (input.richMedia?.length ?? 0) ||
    images.some(
      (part, index) => input.richMedia?.[index]?.reference.id !== part.media.id
    )
  ) {
    return 'missing_media'
  }
  if (
    (input.richMedia ?? []).some(
      (media) =>
        media.reference.kind !== 'image' ||
        !['image/jpeg', 'image/png'].includes(media.reference.mimeType) ||
        media.data.byteLength >
          Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, 10_000_000)
    )
  ) {
    return 'image_format_or_size_unsupported'
  }
  return undefined
}

export async function richMessage(
  input: SendInput,
  host: ChannelHost
): Promise<Json> {
  const contents: Json[] = []
  const labels: string[] = []
  for (const part of input.chunk.richText ?? []) {
    if (part.type === 'text') {
      contents.push(...lineContents(part.text))
      labels.push(markdownText(part.text))
    } else {
      if (!host.media) {
        throw new Error('public_media_unavailable')
      }

      const url = await host.media.publish({
        channelId: input.channelId,
        mediaId: part.media.id
      })

      contents.push({ type: 'image', url, size: 'full', aspectMode: 'fit' })
      labels.push(part.label || part.media.fileName)
    }
  }
  const preview = labels.join('\n').slice(0, 1500)

  const message: Json = {
    type: 'flex',
    altText:
      (preview.isWellFormed() ? preview : preview.slice(0, -1)) || 'Message',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents }
    }
  }

  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 30_000) {
    throw new Error('rich_message_limit_exceeded')
  }
  return message
}
