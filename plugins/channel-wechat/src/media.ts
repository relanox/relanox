import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto'
import { downloadMedia, MediaDownloadError } from '@relanox/channel-media'
import type { MediaUpload, StoredMedia, Json } from '@relanox/sdk'
import { z } from 'zod'
import type { WechatClient, WechatItem } from './protocol.js'

function cdnUrl(
  client: WechatClient,
  full: string | undefined,
  operation: 'upload' | 'download',
  param: string,
  filekey?: string
): URL {
  const base = new URL(client.config.cdnBaseUrl)

  const url = full
    ? new URL(full)
    : new URL(`${base.href.replace(/\/$/u, '')}/${operation}`)

  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `${base.pathname.replace(/\/$/u, '')}/${operation}`
  ) {
    throw new Error('invalid_cdn_destination')
  }
  if (!full) {
    url.searchParams.set('encrypted_query_param', param)
    if (filekey) {
      url.searchParams.set('filekey', filekey)
    }
  }
  return url
}

function aesKey(
  hex: string | undefined,
  base64: string | undefined
): Buffer | undefined {
  if (hex !== undefined) {
    if (!/^[\da-f]{32}$/iu.test(hex)) {
      throw new Error('invalid_media_key')
    }
    return Buffer.from(hex, 'hex')
  }
  if (!base64) {
    return undefined
  }
  const raw = Buffer.from(base64, 'base64')
  if (raw.length === 16) {
    return raw
  }
  if (/^[\da-f]{32}$/iu.test(raw.toString('ascii'))) {
    return Buffer.from(raw.toString('ascii'), 'hex')
  }
  throw new Error('invalid_media_key')
}

function description(item: WechatItem):
  | {
      kind: MediaUpload['kind']
      content: NonNullable<WechatItem['image_item']>
      mimeType: string
      fileName: string
    }
  | undefined {
  if (item.type === 2 && item.image_item) {
    return {
      kind: 'image',
      content: item.image_item,
      mimeType: 'image/jpeg',
      fileName: 'image.jpg'
    }
  }
  if (item.type === 3 && item.voice_item) {
    const codecs: Readonly<
      Record<number, { mimeType: string; extension: string }>
    > = {
      5: { mimeType: 'audio/amr', extension: 'amr' },
      6: { mimeType: 'audio/silk', extension: 'silk' },
      7: { mimeType: 'audio/mpeg', extension: 'mp3' },
      8: { mimeType: 'audio/ogg', extension: 'ogg' }
    }

    const codec = codecs[item.voice_item.encode_type ?? -1]
    return {
      kind: codec ? 'audio' : 'file',
      content: item.voice_item,
      mimeType: codec?.mimeType ?? 'application/octet-stream',
      fileName: `voice.${codec?.extension ?? 'bin'}`
    }
  }
  if (item.type === 4 && item.file_item) {
    return {
      kind: 'file',
      content: item.file_item,
      mimeType: 'application/octet-stream',
      fileName: item.file_item.file_name ?? 'attachment'
    }
  }
  if (item.type === 5 && item.video_item) {
    return {
      kind: 'video',
      content: item.video_item,
      mimeType: 'video/mp4',
      fileName: 'video.mp4'
    }
  }
  return undefined
}

export async function receiveMedia(
  client: WechatClient,
  items: readonly WechatItem[],
  maxBytes: number,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const attachments: MediaUpload[] = []
  for (const item of items) {
    const desc = description(item)
    if (!desc?.content.media) {
      continue
    }
    const ref = desc.content.media
    // Official CDNMedia uses encrypt_type for the encrypted file-id envelope,
    // Not cipher selection. Both 0 and 1 use the supplied AES key for bytes.
    // https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
    // https://github.com/Tencent/openclaw-weixin/blob/main/src/media/media-download.ts
    if (!ref.encrypt_query_param && !ref.full_url) {
      continue
    }
    const key = aesKey(desc.content.aeskey, ref.aes_key)
    if (!key && desc.kind !== 'image') {
      continue
    }

    const url = cdnUrl(
      client,
      ref.full_url,
      'download',
      ref.encrypt_query_param ?? ''
    )

    const response = await downloadMedia(url.href, {
      maxBytes: maxBytes + 16,
      signal,
      trustedOrigins: [new URL(client.config.cdnBaseUrl).origin],
      allowInsecureLocalhost: client.config.allowInsecureLoopback
    })

    let data: Uint8Array = response.data
    if (key) {
      const cipher = createDecipheriv('aes-128-ecb', key, null)
      data = Buffer.concat([cipher.update(data), cipher.final()])
    }
    if (data.byteLength > maxBytes) {
      throw new MediaDownloadError('media_too_large')
    }
    const image = desc.kind === 'image' ? imageFormat(data) : undefined
    const durationMs = desc.content.playtime
    attachments.push({
      kind: desc.kind,
      data,
      mimeType: image?.mimeType ?? desc.mimeType,
      fileName: image?.fileName ?? desc.fileName,
      ...(durationMs !== undefined &&
      Number.isSafeInteger(durationMs) &&
      durationMs > 0
        ? { durationMs }
        : {})
    })
  }
  return attachments
}

function imageFormat(
  data: Uint8Array
): { mimeType: string; fileName: string } | undefined {
  const bytes = Buffer.from(data)
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { mimeType: 'image/png', fileName: 'image.png' }
  }
  if (
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a'
  ) {
    return { mimeType: 'image/gif', fileName: 'image.gif' }
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', fileName: 'image.webp' }
  }
  return undefined
}

export async function uploadMedia(
  client: WechatClient,
  media: StoredMedia,
  recipient: string,
  signal: AbortSignal
): Promise<Json> {
  const key = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const ciphertext = Buffer.concat([cipher.update(media.data), cipher.final()])
  const kind = media.reference.kind
  const mediaType = { image: 1, video: 2, file: 3, audio: 3 }[kind]

  const result = z
    .object({
      upload_full_url: z.string().optional(),
      upload_param: z.string().optional()
    })
    .parse(
      await client.post(
        'getuploadurl',
        {
          filekey,
          media_type: mediaType,
          to_user_id: recipient,
          rawsize: media.data.byteLength,
          rawfilemd5: createHash('md5').update(media.data).digest('hex'),
          filesize: ciphertext.length,
          no_need_thumb: true,
          aeskey: key.toString('hex')
        },
        signal
      )
    )

  if (!result.upload_full_url && !result.upload_param) {
    throw new Error('missing_upload_url')
  }

  const url = cdnUrl(
    client,
    result.upload_full_url,
    'upload',
    result.upload_param ?? '',
    filekey
  )

  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext
  })

  const downloadParam = response.headers.get('x-encrypted-param')
  if (response.status !== 200 || !downloadParam) {
    throw new Error('media_upload_failed')
  }

  const ref = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(key.toString('hex')).toString('base64'),
    encrypt_type: 1
  }

  if (kind === 'image') {
    return { type: 2, image_item: { media: ref, mid_size: ciphertext.length } }
  }
  if (kind === 'video') {
    return {
      type: 5,
      video_item: { media: ref, video_size: ciphertext.length }
    }
  }
  return {
    type: 4,
    file_item: {
      media: ref,
      file_name: media.reference.fileName,
      len: String(media.data.byteLength)
    }
  }
}
