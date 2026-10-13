import { afterEach, expect, it } from 'vitest'
import { createTelegramChannel } from '../src/index.js'
import { recorder, sendInput } from './peer.js'
import { mediaPeer, multipart } from './media-peer.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})

// Native method limits and response shape: grammY ee0c650ed0908b2478c12b863afd03aac8e07212,
// Src/core/api.ts sendPhoto/sendAnimation; https://core.telegram.org/bots/api#sendanimation.
it.each([
  { mimeType: 'image/gif', size: 11 * 1024 * 1024, maxMiB: 64, status: 'sent' },
  {
    mimeType: 'image/png',
    size: 11 * 1024 * 1024,
    maxMiB: 64,
    status: 'rejected'
  },
  {
    mimeType: 'image/gif',
    size: 51 * 1024 * 1024,
    maxMiB: 64,
    status: 'rejected'
  },
  {
    mimeType: 'image/gif',
    size: 26 * 1024 * 1024,
    maxMiB: 25,
    status: 'rejected'
  }
])(
  'applies native upload limits for $mimeType at $size bytes',
  async (test) => {
    const remote = await mediaPeer(() => ({
      json: { ok: true, result: { message_id: 900 } }
    }))

    cleanup.push(remote.close)
    const plugin = createTelegramChannel({ TOKEN: '123:abc', SECRET: 'secret' })
    const { host } = recorder()
    await plugin.setup(
      { ...host, maxMediaBytes: test.maxMiB * 1024 * 1024 },
      { id: 'tg', channel: 'telegram', config: null, allowedSenders: ['42'] },
      plugin.validateConfig({
        botToken: { env: 'TOKEN' },
        webhookSecret: { env: 'SECRET' },
        apiBaseUrl: remote.origin,
        allowInsecureLoopback: true
      })
    )

    const resolved = await plugin.resolveChannel?.({
      id: 'channel-1',
      platform: 'telegram',
      accountId: 'tg',
      chatId: '-1007',
      threadId: '8'
    })

    if (resolved?.status !== 'available') {
      throw new Error('missing_target')
    }

    const reference = {
      id: 'media-1',
      kind: 'image' as const,
      mimeType: test.mimeType,
      fileName: test.mimeType === 'image/gif' ? 'animation.gif' : 'photo.png',
      size: test.size,
      sha256: 'a'.repeat(64)
    }

    const input = sendInput(resolved.target)
    expect(
      (
        await plugin.send({
          ...input,
          chunk: { ...input.chunk, text: '', media: reference },
          media: { reference, data: new Uint8Array(test.size) }
        })
      ).status
    ).toBe(test.status)
    if (test.status === 'rejected') {
      expect(remote.traffic).toEqual([])
      return
    }
    expect(remote.traffic).toHaveLength(1)
    const traffic = remote.traffic[0]
    if (!traffic) {
      throw new Error('missing_upload')
    }
    expect(traffic.path).toBe('/bot123:abc/sendAnimation')
    const form = await multipart(traffic)
    expect(form.get('chat_id')).toBe('-1007')
    expect(form.get('message_thread_id')).toBe('8')
    const file = form.get('animation')
    expect(file).toBeInstanceOf(File)
    if (!(file instanceof File)) {
      throw new Error('missing_animation')
    }
    expect(file.size).toBe(11 * 1024 * 1024)
    expect(file.name).toBe('animation.gif')
    expect(file.type).toBe('image/gif')
  }
)
