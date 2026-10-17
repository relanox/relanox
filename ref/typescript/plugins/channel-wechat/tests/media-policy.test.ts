import { createCipheriv } from 'node:crypto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  body,
  harness,
  httpPeer,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createWechatChannel } from '../src/index.js'

// Primary wire fixtures: CDNMedia encrypt_type=0 encrypts only the file ID;
// Encrypt_type=1 packages thumbnail/mid-size metadata. Neither selects the cipher.
// https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
// https://github.com/Tencent/openclaw-weixin/blob/main/src/media/media-download.ts
// https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/inbound.ts
// Protect accepted native media and subsequent batch messages/cursor progress.
// Rejecting type 0, retaining a permanent Core media-policy rejection, or failing
// To skip missing optional media URLs stalls all following messages. Prior tests
// Cover successful type-1 transfers and temporary HTTP errors only. Item-only
// IDs and zero/unknown voice durations must also survive the native/Core boundary.
// These use
// Real Core/SQLite and an HTTP peer without any test-only production interfaces.
it.each([
  {
    name: 'native envelope type zero',
    count: 1,
    expectedEvents: ['101', '18446744073709551615']
  },
  { name: 'too many attachments', count: 2, expectedEvents: ['101'] }
])(
  'advances past $name and commits the following message before the cursor',
  async ({ count, expectedEvents }) => {
    const aeskey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const cipher = createCipheriv('aes-128-ecb', aeskey, null)
    const encrypted = Buffer.concat([cipher.update('abc'), cipher.final()])
    const cursors: string[] = []

    const peer = await httpPeer(async (request, response) => {
      if (request.url?.startsWith('/c2c/download')) {
        response.end(encrypted)
        return
      }

      const raw = z
        .object({ get_updates_buf: z.string() })
        .parse(await body(request))

      cursors.push(raw.get_updates_buf)
      if (raw.get_updates_buf) {
        return
      }

      const payload = {
        ret: 0,
        get_updates_buf: 'batch-complete',
        msgs: [
          {
            from_user_id: 'alice',
            message_type: 1,
            context_token: 'context',
            item_list: Array.from({ length: count }, () => ({
              type: 3,
              msg_id: '18446744073709551615',
              voice_item: {
                encode_type: 6,
                playtime: 0,
                media: {
                  encrypt_type: 0,
                  encrypt_query_param: 'file',
                  aes_key: aeskey.toString('base64')
                }
              }
            }))
          },
          {
            message_id: '101',
            from_user_id: 'alice',
            message_type: 1,
            context_token: 'new-context',
            item_list: [
              { type: 1, text_item: { text: 'following message' } },
              { type: 2, image_item: { media: {} } }
            ]
          }
        ]
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify(payload).replaceAll(
          '"msg_id":"18446744073709551615"',
          '"msg_id":18446744073709551615'
        )
      )
    })

    const plugin = createWechatChannel({ TOKEN: 'token' })

    const fixture = await harness(
      plugin,
      {
        botId: 'bot@im.bot',
        botToken: { env: 'TOKEN' },
        apiBaseUrl: peer.base,
        cdnBaseUrl: `${peer.base}/c2c`,
        allowInsecureLoopback: true
      },
      [{ chatId: 'alice' }],
      ['alice'],
      `${peer.base}/dispatch`,
      { worker: { maxAttachments: 1 } }
    )

    await plugin.start?.(new AbortController().signal)
    await waitFor(() => cursors.includes('batch-complete'))
    await plugin.stop?.()
    const events = await fixture.storage.listInbound({ limit: 10 })
    expect(
      events.map((event) => event.snapshot.source.eventId).toSorted()
    ).toEqual(expectedEvents)

    const mediaEvent = events.find(
      (event) => event.snapshot.source.eventId === '18446744073709551615'
    )

    if (count === 1) {
      const attachment = mediaEvent?.snapshot.attachments?.[0]
      expect(attachment).toMatchObject({
        kind: 'audio',
        fileName: 'voice.silk',
        size: 3
      })
      expect(attachment).not.toHaveProperty('durationMs')
      if (!mediaEvent || !attachment) {
        throw new Error('missing_attachment')
      }
      expect(
        (
          await fixture.storage.media?.get(
            mediaEvent.snapshot.channel.id,
            attachment.id
          )
        )?.data
      ).toEqual(new Uint8Array([97, 98, 99]))
    }
    expect(
      events.find((event) => event.snapshot.source.eventId === '101')?.snapshot
        .text
    ).toBe('following message')
    expect(cursors).toEqual(['', 'batch-complete'])
  }
)
