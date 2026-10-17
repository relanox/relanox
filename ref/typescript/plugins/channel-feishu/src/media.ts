import { mediaKind, MediaDownloadError } from '@relanox/channel-media'
import type {
  ChannelHost,
  MediaUpload,
  SendInput,
  StoredMedia
} from '@relanox/sdk'
import type {
  LarkChannel,
  ResourceDescriptor,
  SendInput as NativeInput
} from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { readBounded } from '@relanox/transport'
import { z } from 'zod'

const resourceHeadersSchema = z.object({
  'content-type': z.string().optional(),
  'content-length': z.coerce.number().optional()
})

const resourceErrorSchema = z.object({
  response: z.object({
    status: z.number(),
    data: z.instanceof(Readable),
    headers: resourceHeadersSchema
  })
})

function contentType(headers: z.infer<typeof resourceHeadersSchema>): string {
  return (
    headers['content-type']?.split(';')[0]?.trim().toLowerCase() ??
    'application/octet-stream'
  )
}

async function resourceFailure(error: unknown): Promise<never> {
  const parsed = resourceErrorSchema.safeParse(error)
  if (!parsed.success) {
    throw error
  }
  const { status, data: stream, headers } = parsed.data.response
  let body: unknown
  try {
    const mimeType = contentType(headers)
    const maxErrorBytes = 64 * 1024
    if (
      (mimeType === 'application/json' || mimeType.endsWith('+json')) &&
      !(Number(headers['content-length']) > maxErrorBytes)
    ) {
      const input = Readable.toWeb(
        stream
      ) as unknown as ReadableStream<Uint8Array>

      body = JSON.parse(
        (await readBounded(input, maxErrorBytes)).toString('utf8')
      ) as unknown
    }
  } catch {
    // Incomplete, oversized and non-JSON errors cannot establish a native code.
  } finally {
    stream.destroy()
  }
  throw new MediaDownloadError('media_download_failed', status, body)
}

async function downloadResource(
  messageId: string,
  resource: ResourceDescriptor,
  channel: LarkChannel,
  maxBytes: number
): Promise<{ data: Buffer; mimeType: string }> {
  let stream: Readable | undefined
  try {
    const downloaded = await channel.rawClient.im.v1.messageResource.get({
      path: {
        message_id: encodeURIComponent(messageId),
        file_key: encodeURIComponent(resource.fileKey)
      },
      params: { type: resource.type === 'image' ? 'image' : 'file' }
    })

    stream = downloaded.getReadableStream()
    const headers = resourceHeadersSchema.parse(downloaded.headers)
    if (Number(headers['content-length']) > maxBytes) {
      throw new MediaDownloadError('media_too_large')
    }

    const input = Readable.toWeb(
      stream
    ) as unknown as ReadableStream<Uint8Array>

    return {
      data: await readBounded(input, maxBytes).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'payload_too_large') {
          throw new MediaDownloadError('media_too_large')
        }
        throw error
      }),
      mimeType: contentType(headers)
    }
  } catch (error) {
    return await resourceFailure(error)
  } finally {
    stream?.destroy()
  }
}

export function isMediaSizeRejection(error: unknown): boolean {
  return error instanceof MediaDownloadError && error.code === 'media_too_large'
}

export function isMediaTokenRejection(error: unknown): boolean {
  return (
    error instanceof MediaDownloadError &&
    error.status !== undefined &&
    [400, 401].includes(error.status) &&
    typeof error.responseBody === 'object' &&
    error.responseBody !== null &&
    'code' in error.responseBody &&
    error.responseBody.code === 99_991_663
  )
}

export async function receiveMedia(
  messageId: string,
  resources: ResourceDescriptor[],
  host: ChannelHost,
  channel: LarkChannel
): Promise<MediaUpload[]> {
  return Promise.all(
    resources.map(async (resource) => {
      const downloaded = await downloadResource(
        messageId,
        resource,
        channel,
        host.maxMediaBytes ?? 100 * 1024 * 1024
      )

      const fallback: Readonly<Record<string, string>> = {
        image: 'image/jpeg',
        audio: 'audio/ogg',
        video: 'video/mp4'
      }

      const mimeType =
        downloaded.mimeType === 'application/octet-stream'
          ? (fallback[resource.type] ?? downloaded.mimeType)
          : downloaded.mimeType

      return {
        kind: mediaKind(mimeType),
        mimeType,
        fileName: resource.fileName ?? resource.fileKey,
        data: downloaded.data,
        ...(resource.durationMs ? { durationMs: resource.durationMs } : {})
      }
    })
  )
}

async function imageKey(
  media: StoredMedia,
  channel: LarkChannel
): Promise<string> {
  const result = await channel.rawClient.im.v1.image.create({
    data: { image_type: 'message', image: Buffer.from(media.data) }
  })

  if (!result?.image_key) {
    throw new Error('missing_uploaded_key')
  }
  return result.image_key
}

export async function nativeContent(
  input: SendInput,
  channel: LarkChannel
): Promise<NativeInput> {
  if (input.chunk.richText) {
    const rows: Record<string, string>[][] = []
    let imageIndex = 0
    for (const part of input.chunk.richText) {
      if (part.type === 'text') {
        rows.push([{ tag: 'md', text: part.text }])
      } else {
        const media = input.richMedia?.[imageIndex++]
        if (!media) {
          throw new Error('missing_media')
        }
        input.signal.throwIfAborted()
        rows.push([{ tag: 'img', image_key: await imageKey(media, channel) }])
      }
    }
    return { post: { zh_cn: { content: rows } } }
  }
  if (!input.chunk.media) {
    return { markdown: input.chunk.text }
  }
  const media = input.media
  if (!media) {
    throw new Error('missing_media')
  }
  const source = Buffer.from(media.data)
  switch (media.reference.kind) {
    case 'image': {
      return { image: { source } }
    }
    case 'audio': {
      return {
        audio: {
          source,
          ...(media.reference.durationMs
            ? { duration: media.reference.durationMs }
            : {})
        }
      }
    }
    case 'video': {
      return {
        video: {
          source,
          ...(media.reference.durationMs
            ? { duration: media.reference.durationMs }
            : {}),
          ...(input.preview
            ? { coverImageKey: await imageKey(input.preview, channel) }
            : {})
        }
      }
    }
    case 'file': {
      return { file: { source, fileName: media.reference.fileName } }
    }
    default: {
      throw new Error('unsupported_media_kind')
    }
  }
}
