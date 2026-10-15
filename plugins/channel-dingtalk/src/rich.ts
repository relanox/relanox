import type { SendInput } from '@relanox/sdk'

export const richCapabilities = {
  maxParts: 20,
  maxTextLength: 2000
}

export function richError(input: SendInput): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }

  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

  const images = parts.filter((part) => part.type === 'image')

  const overhead =
    images.reduce(
      (size, part) =>
        size +
        Buffer.byteLength(part.label || part.media.fileName, 'utf8') +
        264,
      0
    ) +
    parts.length * 2

  if (Buffer.byteLength(text, 'utf8') + overhead > 4000) {
    return 'rich_text_limit_exceeded'
  }
  if (images.length === 0 || images.length !== input.richMedia?.length) {
    return 'invalid_rich_media'
  }
  // Core verifies the stored metadata and bytes before dispatch. Only match
  // Ordered image references here; the platform validates upload formats.
  if (
    images.some(
      (part, index) => input.richMedia?.[index]?.reference.id !== part.media.id
    )
  ) {
    return 'invalid_rich_media'
  }
  return undefined
}
