import type {
  ChannelHost,
  SendInput,
  StoredMedia,
  RichTextPart
} from '@relanox/sdk'

export const richCapabilities = {
  maxParts: 20,
  maxTextLength: 2000,
  imageMimeTypes: ['image/png', 'image/jpeg', 'image/gif'],
  maxImageBytes: 1_000_000
}

export function richError(
  input: SendInput,
  host: ChannelHost
): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }
  if (!host.publicUrl?.startsWith('https://') || !host.media) {
    return 'media_publication_unavailable'
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

  if (text.length > richCapabilities.maxTextLength) {
    return 'rich_text_limit_exceeded'
  }
  const images = parts.filter((part) => part.type === 'image')
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
    !['image/png', 'image/jpeg', 'image/gif'].includes(part.media.mimeType) ||
    stored.data.byteLength >
      Math.min(
        host.maxMediaBytes ?? 25 * 1024 * 1024,
        richCapabilities.maxImageBytes
      ) ||
    (part.label || part.media.fileName).length > 2000
  )
}
