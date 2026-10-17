import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  body,
  harness,
  httpPeer,
  json,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createWechatChannel } from '../src/index.js'

// Primary fixtures: https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
// Protect replay when an attachment fails before Core acceptance. Advancing the
// Cursor on receipt would lose this event. Success-only restart coverage cannot
// Catch that failure. Real SQLite/Core and HTTP peers need no additional seam.
it('retains the previous cursor when media fails, then ingests the event after restart', async () => {
  let unavailable = true
  let downloads = 0
  const cursors: string[] = []

  const peer = await httpPeer(async (request, response) => {
    if (request.url?.startsWith('/c2c/download')) {
      downloads += 1
      response.writeHead(unavailable ? 503 : 200)
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return
    }

    const raw = z
      .object({ get_updates_buf: z.string() })
      .parse(await body(request))

    cursors.push(raw.get_updates_buf)
    if (raw.get_updates_buf) {
      return
    }
    json(response, {
      ret: 0,
      get_updates_buf: 'accepted-cursor',
      msgs: [
        {
          message_id: '91',
          from_user_id: 'alice',
          message_type: 1,
          context_token: 'context',
          item_list: [
            { type: 2, image_item: { media: { encrypt_query_param: 'image' } } }
          ]
        }
      ]
    })
  })

  const configuration = {
    botId: 'bot@im.bot',
    botToken: { env: 'TOKEN' },
    apiBaseUrl: peer.base,
    cdnBaseUrl: `${peer.base}/c2c`,
    allowInsecureLoopback: true
  }

  const firstPlugin = createWechatChannel({ TOKEN: 'token' })

  const first = await harness(
    firstPlugin,
    configuration,
    [{ chatId: 'alice' }],
    ['alice'],
    `${peer.base}/dispatch`
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(() => downloads === 1)
  await firstPlugin.stop?.()
  expect(await first.storage.listInbound({ limit: 10 })).toEqual([])
  await first.storage.close()
  unavailable = false
  const nextPlugin = createWechatChannel({ TOKEN: 'token' })

  const next = await harness(
    nextPlugin,
    configuration,
    [{ chatId: 'alice' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(() => cursors.includes('accepted-cursor'))
  await nextPlugin.stop?.()
  expect(cursors.slice(0, 2)).toEqual(['', ''])
  expect(await next.storage.listInbound({ limit: 10 })).toHaveLength(1)
})
