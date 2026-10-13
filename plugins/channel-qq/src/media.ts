import { downloadMedia, mediaKind } from '@relanox/channel-media'
import type { ChannelHost, MediaUpload } from '@relanox/sdk'
import type { z } from 'zod'
import type { QqConfig } from './config.js'
import type { messageSchema } from './schemas.js'

export async function downloadAttachments(
  attachments: NonNullable<z.infer<typeof messageSchema>['attachments']>,
  host: ChannelHost,
  config: QqConfig,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const uploads: MediaUpload[] = []
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

    // QQ uses voice/file as native labels, not MIME types. Keep unknown voice bytes opaque.
    const nativeType = attachment.content_type

    const mimeType =
      nativeType === 'voice' || nativeType === 'file'
        ? downloaded.mimeType
        : (nativeType ?? downloaded.mimeType)

    uploads.push({
      data: downloaded.data,
      mimeType,
      kind: nativeType === 'file' ? 'file' : mediaKind(mimeType),
      fileName:
        attachment.filename ??
        new URL(url).pathname.split('/').at(-1) ??
        'attachment.bin'
    })
  }
  return uploads
}
