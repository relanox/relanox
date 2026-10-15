import { escapeHtml, markdownText, renderHtml } from '@relanox/markdown'
import type { SendInput } from '@relanox/sdk'
import { MsgType } from 'matrix-js-sdk'
import type { RoomMessageTextEventContent } from 'matrix-js-sdk/lib/@types/events.js'

export function richError(input: SendInput): string | undefined {
  const parts = input.chunk.richText
  if (!parts) {
    return undefined
  }
  if (
    parts.length > 20 ||
    Buffer.byteLength(
      parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      'utf8'
    ) > 8000
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
    (input.richMedia ?? []).some((media) => media.reference.kind !== 'image')
  ) {
    return 'media_limit_exceeded'
  }
  return undefined
}

export function richContent(
  input: SendInput,
  urls: readonly string[]
): RoomMessageTextEventContent {
  let imageIndex = 0
  const body: string[] = []
  const html: string[] = []
  for (const part of input.chunk.richText ?? []) {
    if (part.type === 'text') {
      body.push(markdownText(part.text))
      html.push(renderHtml(part.text))
    } else {
      const url = urls[imageIndex++]
      if (!url) {
        throw new Error('missing_media')
      }
      body.push(part.label || part.media.fileName)
      html.push(
        `<img src="${escapeHtml(url)}" alt="${escapeHtml(part.label)}">`
      )
    }
  }
  return {
    msgtype: MsgType.Text,
    body: body.join('\n\n'),
    format: 'org.matrix.custom.html',
    formatted_body: html.join('')
  }
}
