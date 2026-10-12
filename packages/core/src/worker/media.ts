import type {
  OutboundRecord,
  ChannelPlugin,
  Storage,
  SendResult
} from '@relanox/sdk'
import { readPreview } from '../hosts/media.js'
import { verifiedMedia } from '../media.js'

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
  return channel.send({
    deliveryId: record.deliveryId,
    channelId: record.channelId,
    target: structuredClone(record.target),
    chunk: structuredClone(chunk),
    chunkIndex: record.currentChunk,
    chunkCount: record.chunks.length,
    ...(media ? { media } : {}),
    ...(preview ? { preview } : {}),
    signal
  })
}
