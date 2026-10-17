import type { SendInput } from '@relanox/sdk'

export const richCapabilities = {
  maxParts: 20,
  maxTextLength: 8000
}

export function richError(input: SendInput): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }
  const images = parts.filter((part) => part.type === 'image')
  return images.length !== input.richMedia?.length ||
    images.some(
      (part, index) => input.richMedia?.[index]?.reference.id !== part.media.id
    )
    ? 'invalid_rich_media'
    : undefined
}
