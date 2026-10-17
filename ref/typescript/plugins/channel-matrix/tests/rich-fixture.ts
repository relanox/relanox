import { createHash } from 'node:crypto'
import { noopObservability } from '@relanox/sdk'
import type { ChannelHost, SendInput, StoredMedia } from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { cleanup } from './harness.js'

export function image(id: string, fileName = 'picture.png'): StoredMedia {
  const data = new Uint8Array([9, 8, 7])
  return {
    reference: {
      id,
      kind: 'image',
      mimeType: 'image/png',
      fileName,
      size: 3,
      sha256: createHash('sha256').update(data).digest('hex')
    },
    data
  }
}

export function richInput(target: SendInput['target']): SendInput {
  const media = image('87dc7f2b-c7df-4be7-908e-8a85d1e4e707')
  return {
    deliveryId: 'delivery',
    channelId: 'authorized-channel',
    target,
    chunkIndex: 0,
    signal: new AbortController().signal,
    chunk: {
      text: '',
      richText: [
        { type: 'text', text: '**Before**' },
        { type: 'image', media: media.reference, label: 'Chart ] <unsafe>' },
        { type: 'text', text: '*After*' }
      ],
      idempotencyKey: 'durable-rich:0',
      state: null
    },
    richMedia: [media]
  }
}

export async function richHost(publication = true): Promise<{
  host: ChannelHost
  published: { channelId: string; mediaId: string }[]
}> {
  const storage = createSqliteStorage({ filename: ':memory:' })
  await storage.initialize()
  cleanup(async () => storage.close())
  const namespace = { pluginId: 'channel-protocol', ownerId: 'account' }
  const published: { channelId: string; mediaId: string }[] = []

  const host: ChannelHost = {
    observe: noopObservability,
    state: {
      get: async (key) => storage.getState(namespace, key),
      list: async (input) => storage.listState(namespace, input),
      compareAndSet: async (input) =>
        storage.compareAndSetState(namespace, input),
      delete: async (key, version) =>
        storage.deleteState(namespace, key, version)
    },
    mountHttp() {},
    connection() {},
    async ingest() {
      throw new Error('unexpected_ingest')
    },
    ...(publication
      ? {
          publicUrl: 'https://relay.example',
          media: {
            async publish(input) {
              published.push(input)
              return `https://relay.example/media/${input.mediaId}?ticket=bound`
            }
          }
        }
      : {})
  }

  return { host, published }
}
