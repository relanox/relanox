import type { Json, SendInput } from '@relanox/sdk'

export function richComponents(input: SendInput): Json[] {
  let imageIndex = 0
  return (input.chunk.richText ?? []).map((part) => {
    if (part.type === 'text') {
      return { type: 10, content: part.text }
    }
    const media = input.richMedia?.[imageIndex]
    if (!media || media.reference.id !== part.media.id) {
      throw new Error('missing_media')
    }
    const fileName = richFileName(imageIndex++, media.reference.fileName)
    const preview = part.label.slice(0, 1024)
    return {
      type: 12,
      items: [
        {
          media: { url: `attachment://${fileName}` },
          description: preview.isWellFormed() ? preview : preview.slice(0, -1)
        }
      ]
    }
  })
}

export function richFileName(index: number, fileName: string): string {
  // Native attachment URLs need a unique safe name, independent of user labels.
  const extension =
    fileName
      .split('.')
      .at(-1)
      ?.toLowerCase()
      .replaceAll(/[^a-z0-9]/gu, '') ?? 'bin'

  return `image-${index}.${extension.slice(0, 10)}`
}
