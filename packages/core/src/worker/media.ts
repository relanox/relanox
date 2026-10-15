import type {
  OutboundRecord,
  ChannelPlugin,
  Storage,
  SendResult,
  DeliveryChunk,
  StoredMedia
} from '@relanox/sdk'
import { readPreview } from '../hosts/media.js'
import { verifiedMedia } from '../media.js'

async function richAssets(
  storage: Storage,
  channelId: string,
  chunk: DeliveryChunk,
  maximum: number
): Promise<StoredMedia[]> {
  const images: StoredMedia[] = []
  for (const part of chunk.richText ?? []) {
    if (part.type !== 'image') {
      continue
    }
    const stored = await storage.media?.get(channelId, part.media.id)
    if (!stored) {
      throw new Error('media_not_found')
    }
    images.push(verifiedMedia(stored, part.media, maximum))
  }
  return images
}

export async function sendChunk(
  storage: Storage,
  channel: ChannelPlugin<unknown> | undefined,
  record: OutboundRecord,
  maximum: number,
  signal: AbortSignal
): Promise<SendResult> {
  const chunk = record.chunks[record.currentChunk]
  if (!chunk) {
    return { status: 'rejected', errorCode: 'invalid_chunk_index' }
  }
  if (!channel) {
    return { status: 'rejected', errorCode: 'plugin_missing' }
  }
  let media
  let preview
  let richMedia
  if (chunk.richText) {
    if (!channel.capabilities.richText) {
      return { status: 'rejected', errorCode: 'rich_text_not_supported' }
    }
    try {
      richMedia = await richAssets(storage, record.channelId, chunk, maximum)
    } catch {
      return { status: 'rejected', errorCode: 'media_integrity_error' }
    }
  }
  if (chunk.media) {
    if (!channel.capabilities.media?.send.includes(chunk.media.kind)) {
      return { status: 'rejected', errorCode: 'media_not_supported' }
    }
    const stored = await storage.media?.get(record.channelId, chunk.media.id)
    if (!stored) {
      return { status: 'rejected', errorCode: 'media_not_found' }
    }
    try {
      media = verifiedMedia(stored, chunk.media, maximum)
      preview = await readPreview(storage, record.channelId, media, maximum)
    } catch {
      return { status: 'rejected', errorCode: 'media_integrity_error' }
    }
  }
  signal.throwIfAborted()
  return channel.send({
    ...(record.reply ? { reply: structuredClone(record.reply) } : {}),
    deliveryId: record.deliveryId,
    channelId: record.channelId,
    target: structuredClone(record.target),
    chunk: structuredClone(chunk),
    chunkIndex: record.currentChunk,
    chunkCount: record.chunks.length,
    ...(media ? { media } : {}),
    ...(preview ? { preview } : {}),
    ...(richMedia ? { richMedia } : {}),
    signal
  })
}
