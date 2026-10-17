import { afterEach, expect, it, vi } from 'vitest'
import { mediaPeer } from './media-peer.js'
import { mediaRuntime } from './media-runtime.js'
import type { Cleanup } from './media-runtime.js'
import { channelConfig } from './media-events.js'

const cleanups: Cleanup[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Native Document/Message/File shapes: https://core.telegram.org/bots/api#document,
// #message and #file; python-telegram-bot 577e9c784607a42ff17746b9864b6416c3c30593.
it('authorizes the account sender before downloading webhook documents', async () => {
  const remote = await mediaPeer((traffic) =>
    traffic.method === 'GET'
      ? { data: Uint8Array.of(1, 2, 3), mimeType: 'application/pdf' }
      : {
          json: {
            ok: true,
            result: {
              file_id: 'native-document',
              file_unique_id: 'document-unique',
              file_size: 3,
              file_path: 'documents/file_1.pdf'
            }
          }
        }
  )

  cleanups.push(remote.close)

  const fixture = await mediaRuntime(
    cleanups,
    'telegram',
    channelConfig('telegram', remote.origin),
    '456',
    '8'
  )

  const runtime = await fixture.start()

  async function webhook(sender: number, update: number): Promise<Response> {
    return fetch(`${runtime.businessUrl}/channels/business/webhook`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'native-secret' },
      body: JSON.stringify({
        update_id: update,
        message: {
          message_id: 9,
          message_thread_id: 8,
          date: 1_760_000_000,
          from: { id: sender, is_bot: false, first_name: 'User' },
          chat: { id: 456, type: 'supergroup', title: 'Documents' },
          document: {
            file_id: 'native-document',
            file_unique_id: 'document-unique',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
            file_size: 3
          }
        }
      })
    })
  }

  expect((await webhook(43, 700)).status).toBe(204)
  expect(remote.traffic).toEqual([])
  expect((await runtime.core.status()).requests).toEqual([])
  expect(fixture.routine.traffic).toEqual([])

  expect((await webhook(42, 701)).status).toBe(204)
  expect(remote.traffic.map((traffic) => traffic.path)).toEqual([
    '/bot123:abc_DEF/getFile',
    '/file/bot123:abc_DEF/documents/file_1.pdf'
  ])
  expect((await runtime.core.status()).requests).toHaveLength(1)
})
