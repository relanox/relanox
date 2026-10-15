import { Buffer } from 'node:buffer'
import type {
  ChannelHost,
  SendInput,
  StoredMedia,
  RichTextPart
} from '@relanox/sdk'

export const richCapabilities = {
  maxParts: 20,
  maxTextLength: 1000,
  imageMimeTypes: ['image/png', 'image/jpeg'],
  maxImageBytes: 20 * 1024 * 1024
}

export function richError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }
  if (
    input.chunk.text ||
    input.chunk.media ||
    input.media ||
    parts.length === 0 ||
    parts.length > richCapabilities.maxParts
  ) {
    return 'invalid_rich_text'
  }

  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  if (Buffer.byteLength(text, 'utf8') > richCapabilities.maxTextLength) {
    return 'rich_text_limit_exceeded'
  }
  const images = parts.filter((part) => part.type === 'image')

  const overhead =
    images.reduce(
      (size, part) =>
        size + Buffer.byteLength(part.label || part.media.fileName, 'utf8') + 8,
      0
    ) +
    parts.length * 2

  if (Buffer.byteLength(text, 'utf8') + overhead > 2000) {
    return 'rich_text_limit_exceeded'
  }
  if (images.length === 0 || images.length !== input.richMedia?.length) {
    return 'invalid_rich_media'
  }
  for (const [index, part] of images.entries()) {
    const stored = input.richMedia?.[index]
    if (invalidImage(stored, part, host)) {
      return 'invalid_rich_media'
    }
  }
  return undefined
}

function invalidImage(
  stored: StoredMedia | undefined,
  part: Extract<RichTextPart, { type: 'image' }>,
  host: ChannelHost
): boolean {
  return (
    !stored ||
    stored.reference.id !== part.media.id ||
    stored.reference.kind !== 'image' ||
    part.media.kind !== 'image' ||
    stored.reference.mimeType !== part.media.mimeType ||
    stored.reference.size !== part.media.size ||
    stored.reference.sha256 !== part.media.sha256 ||
    stored.reference.fileName !== part.media.fileName ||
    stored.data.byteLength === 0 ||
    stored.data.byteLength !== part.media.size ||
    !richCapabilities.imageMimeTypes.includes(part.media.mimeType) ||
    stored.data.byteLength >
      Math.min(
        host.maxMediaBytes ?? 100 * 1024 * 1024,
        richCapabilities.maxImageBytes
      ) ||
    (part.label || part.media.fileName).length > 2000
  )
}

export async function richMarkdown(
  input: SendInput,
  host: ChannelHost
): Promise<string> {
  if (!input.chunk.richText) {
    return input.chunk.text
  }
  if (!host.media || !host.publicUrl?.startsWith('https://')) {
    throw new Error('media_publication_unavailable')
  }
  const fragments: string[] = []
  for (const part of input.chunk.richText) {
    if (part.type === 'text') {
      fragments.push(part.text)
    } else {
      const url = new URL(
        await host.media.publish({
          channelId: input.channelId,
          mediaId: part.media.id
        })
      )

      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error('invalid_publication_url')
      }

      const label = (part.label || part.media.fileName).replaceAll(
        /[\\[\]\r\n]/gu,
        ' '
      )

      fragments.push(
        `![${label}](${url.href.replaceAll(/[()]/gu, encodeURIComponent)})`
      )
    }
  }
  const markdown = fragments.join('\n\n')
  if (Buffer.byteLength(markdown, 'utf8') > 2000) {
    throw new Error('rich_text_limit_exceeded')
  }
  return markdown
}
