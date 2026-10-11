import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ChannelHost, SendInput, SendResult } from '@relanox/sdk'

const imageSchema = z.object({ base64: z.string(), md5: z.string() })

const streamSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  chatId: z.string(),
  expiresAt: z.number(),
  content: z.string(),
  images: z.array(imageSchema),
  deliveryId: z.string().default(''),
  nextChunk: z.number().int(),
  finish: z.boolean(),
  served: z.boolean()
})

export function streamId(botId: string, eventId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([botId, eventId]))
    .digest('hex')
}

const stateKey = (id: string): string => `stream:${id}`

export async function startPassive(
  host: ChannelHost,
  id: string,
  eventId: string,
  chatId: string
): Promise<void> {
  const expiresAt = Date.now() + 10 * 60 * 1000
  const saved = await host.state.get(stateKey(id))
  if (saved) {
    return
  }

  const result = await host.state.compareAndSet({
    key: stateKey(id),
    expectedVersion: null,
    expiresAt,
    value: {
      id,
      eventId,
      chatId,
      expiresAt,
      content: '',
      images: [],
      nextChunk: 0,
      finish: false,
      served: false
    }
  })

  if (result.status !== 'updated' && result.status !== 'conflict') {
    throw new Error('callback_state_unavailable')
  }
}

export async function passiveResponse(
  host: ChannelHost,
  id: string,
  chatId?: string
): Promise<object | undefined> {
  const entry = await host.state.get(stateKey(id))
  const parsed = streamSchema.safeParse(entry?.value)
  if (!entry || !parsed.success || parsed.data.expiresAt <= Date.now()) {
    return undefined
  }
  const state = parsed.data
  if (chatId !== undefined && chatId !== state.chatId) {
    throw new Error('callback_identity_mismatch')
  }
  if (state.finish && !state.served) {
    const result = await host.state.compareAndSet({
      key: entry.key,
      expectedVersion: entry.version,
      expiresAt: state.expiresAt,
      value: { ...state, served: true }
    })

    if (result.status !== 'updated') {
      throw new Error('callback_state_conflict')
    }
  }
  return {
    msgtype: 'stream',
    stream: {
      id,
      finish: state.finish,
      content: state.finish ? state.content : '',
      ...(state.finish && state.images.length > 0
        ? {
            msg_item: state.images.map((image) => ({ msgtype: 'image', image }))
          }
        : {})
    }
  }
}

function appendMedia(
  images: z.infer<typeof imageSchema>[],
  input: SendInput
): SendResult | undefined {
  if (input.chunk.media && !input.media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }
  if (!input.media) {
    return undefined
  }
  if (
    input.media.reference.kind !== 'image' ||
    !['image/png', 'image/jpeg'].includes(input.media.reference.mimeType)
  ) {
    return { status: 'rejected', errorCode: 'unsupported_callback_media' }
  }
  if (
    input.media.data.byteLength === 0 ||
    input.media.data.byteLength > 10 * 1024 * 1024 ||
    images.length >= 10
  ) {
    return { status: 'rejected', errorCode: 'unsupported_callback_media_size' }
  }
  images.push({
    base64: Buffer.from(input.media.data).toString('base64'),
    md5: createHash('md5').update(input.media.data).digest('hex')
  })
  return undefined
}

export async function stagePassive(
  host: ChannelHost,
  id: string,
  input: SendInput
): Promise<SendResult> {
  const entry = await host.state.get(stateKey(id))
  const parsed = streamSchema.safeParse(entry?.value)
  if (!entry || !parsed.success || parsed.data.expiresAt <= Date.now()) {
    return { status: 'rejected', errorCode: 'callback_stream_expired' }
  }
  const state = parsed.data
  if (
    state.eventId !== input.target.replyToId ||
    state.chatId !== input.target.chatId
  ) {
    return { status: 'rejected', errorCode: 'target_identity_changed' }
  }
  if (state.deliveryId && state.deliveryId !== input.deliveryId) {
    return { status: 'rejected', errorCode: 'callback_reply_used' }
  }
  if (input.chunkIndex < state.nextChunk) {
    return state.finish && !state.served
      ? {
          status: 'pending',
          retryAfterMs: 1000
        }
      : { status: 'sent', receipt: {} }
  }
  if (input.chunkIndex !== state.nextChunk || state.finish) {
    return { status: 'rejected', errorCode: 'invalid_callback_chunk' }
  }
  if (input.signal.aborted) {
    return { status: 'retryable', errorCode: 'callback_stopped' }
  }
  const images = [...state.images]
  const failure = appendMedia(images, input)
  if (failure) {
    return failure
  }
  const content = state.content + input.chunk.text
  if (Buffer.byteLength(content) > 20_480) {
    return { status: 'rejected', errorCode: 'text_too_long' }
  }
  const count = input.chunkCount ?? 1
  const finish = input.chunkIndex + 1 === count

  const result = await host.state.compareAndSet({
    key: entry.key,
    expectedVersion: entry.version,
    expiresAt: state.expiresAt,
    value: {
      ...state,
      content,
      images,
      deliveryId: input.deliveryId,
      nextChunk: input.chunkIndex + 1,
      finish
    }
  })

  if (result.status !== 'updated') {
    return { status: 'retryable', errorCode: 'callback_state_conflict' }
  }
  return finish
    ? {
        status: 'pending',
        retryAfterMs: 1000
      }
    : { status: 'sent', receipt: { data: { staged: true } } }
}
