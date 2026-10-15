import { downloadMedia, mediaKind } from '@relanox/channel-media'
import { attachmentMimeType } from './mime.js'
import type { ChannelHost, MediaUpload } from '@relanox/sdk'
import type { z } from 'zod'
import type { messageSchema } from './schemas.js'

type Attachment = NonNullable<
  z.infer<typeof messageSchema>['attachments']
>[number]

type Attachments = {
  uploads: MediaUpload[]
  fallbacks: string[]
  remoteImages: { url: string; fileName: string }[]
}

function remoteUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function retainAttachment(attachment: Attachment, result: Attachments): void {
  const url = remoteUrl(attachment.url)

  const fileName = attachment.filename?.length
    ? attachment.filename
    : 'attachment'

  const mime = attachmentMimeType(
    attachment.content_type,
    '',
    fileName,
    new Uint8Array()
  )

  if (mime.startsWith('image/') && url) {
    result.remoteImages.push({ url, fileName })
    result.fallbacks.push(`[Image: ${url}]`)
  } else if (attachment.content_type === 'voice' || mime.startsWith('audio/')) {
    result.fallbacks.push(
      attachment.asr_refer_text?.trim()
        ? attachment.asr_refer_text.trim()
        : '[Voice message - transcription unavailable]'
    )
  } else {
    result.fallbacks.push(`[Attachment: ${fileName}]`)
  }
}

/** A failed CDN download does not discard the message or the other attachments. */
export async function downloadAttachments(
  attachments: readonly Attachment[],
  host: ChannelHost,
  signal: AbortSignal
): Promise<Attachments> {
  const result: Attachments = { uploads: [], fallbacks: [], remoteImages: [] }
  for (const attachment of attachments) {
    signal.throwIfAborted()
    try {
      const url = remoteUrl(attachment.url)
      if (!url) {
        throw new Error('missing_attachment_url')
      }

      const downloaded = await downloadMedia(url, {
        maxBytes: host.maxMediaBytes ?? 100 * 1024 * 1024,
        signal,
        trustedOrigins: [],
        allowInsecureLocalhost: false
      })

      const fileName =
        [attachment.filename, new URL(url).pathname.split('/').at(-1)].find(
          (value) => value?.length
        ) ?? 'attachment.bin'

      const mimeType = attachmentMimeType(
        attachment.content_type,
        downloaded.mimeType,
        fileName,
        downloaded.data
      )

      result.uploads.push({
        data: downloaded.data,
        mimeType,
        kind: mediaKind(mimeType),
        fileName
      })
    } catch {
      signal.throwIfAborted()
      host.observe.log('warn', 'channel_attachment_unavailable', {
        errorCode: 'media_download_failed'
      })
      retainAttachment(attachment, result)
    }
  }
  return result
}
