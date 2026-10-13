import {
  downloadMedia,
  mediaKind,
  MediaDownloadError
} from '@relanox/channel-media'
import { attachmentMimeType } from './mime.js'
import type { ChannelHost, MediaUpload } from '@relanox/sdk'
import type { z } from 'zod'
import type { QqConfig } from './config.js'
import type { messageSchema } from './schemas.js'

export async function downloadAttachments(
  attachments: NonNullable<z.infer<typeof messageSchema>['attachments']>,
  host: ChannelHost,
  config: QqConfig,
  signal: AbortSignal
): Promise<MediaUpload[] | undefined> {
  const uploads: MediaUpload[] = []
  try {
    for (const attachment of attachments) {
      if (!attachment.url) {
        throw new Error('missing_attachment_url')
      }

      const url = attachment.url.startsWith('//')
        ? `https:${attachment.url}`
        : attachment.url

      const downloaded = await downloadMedia(url, {
        maxBytes: host.maxMediaBytes ?? 25 * 1024 * 1024,
        signal,
        trustedOrigins: [],
        allowInsecureLocalhost: false
      })

      const fileName =
        attachment.filename ??
        new URL(url).pathname.split('/').at(-1) ??
        'attachment.bin'

      const mimeType = attachmentMimeType(
        attachment.content_type,
        downloaded.mimeType,
        fileName,
        downloaded.data
      )

      uploads.push({
        data: downloaded.data,
        mimeType,
        kind: mediaKind(mimeType),
        fileName
      })
    }
  } catch (error) {
    if (
      error instanceof MediaDownloadError &&
      error.code === 'media_too_large'
    ) {
      host.observe.log('info', 'channel_unsupported_input', {
        errorCode: error.code
      })
      return undefined
    }
    throw error
  }
  return uploads
}
