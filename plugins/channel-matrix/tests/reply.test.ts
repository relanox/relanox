import { expect, it } from 'vitest'
import { z } from 'zod'
import { assemble, records } from '../../channel-wecom/tests/test-support.js'
import { body, httpPeer, json, waitFor } from './harness.js'
import { createMatrixChannel } from '../src/index.js'

// https://spec.matrix.org/v1.15/client-server-api/#rich-replies
// Protects selected persisted event IDs through Core resolution and ordinary sends.
// Direct send tests cannot detect selected-target loss or latest-message quoting.
// Uses production AgentHost and SQLite plus native HTTP traffic; no testing seam.
it('quotes selected sync events out of order and leaves ordinary sends unquoted', async () => {
  let synchronized = false
  const sent: unknown[] = []

  const remote = await httpPeer(async (request, response) => {
    if (request.url?.includes('/sync')) {
      const events = synchronized
        ? []
        : ['$11', '$22', '$33'].map((id) => ({
            event_id: id,
            sender: '@alice:local.test',
            type: 'm.room.message',
            origin_server_ts: 1_800_000_000_000,
            content: { msgtype: 'm.text', body: `question ${id}` }
          }))

      synchronized = true
      json(response, {
        next_batch: 'accepted',
        rooms: {
          join: {
            '!room:local.test': { timeline: { events } }
          }
        }
      })
      return
    }
    if (request.url?.includes('/state/')) {
      json(response, { errcode: 'M_NOT_FOUND' }, 404)
      return
    }
    sent.push(await body(request))
    json(response, { event_id: '$answer' })
  })

  const plugin = createMatrixChannel({ TOKEN: 'token' })

  const fixture = await assemble(
    plugin,
    {
      homeserver: remote.base,
      accessToken: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    },
    [{ chatId: '!room:local.test', senderId: '@alice:local.test' }]
  )

  await fixture.start()
  await waitFor(async () => (await records(fixture.storage)).length === 3)
  await plugin.stop?.()
  const received = await records(fixture.storage)
  for (const id of ['$22', '$11', '$33']) {
    const request = received.find(
      (item) => item.snapshot.target.replyToId === id
    )

    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fixture.principal().sendMessage({
        channel: request.snapshot.channel.id,
        text: `answer ${id}`,
        reply: { requestId: request.snapshot.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await fixture.runtime.processDue()
  }
  const channel = received[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await fixture.principal().sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await fixture.runtime.processDue()
  expect(
    sent.map((message) =>
      z
        .object({
          body: z.string(),
          'm.relates_to': z
            .object({ 'm.in_reply_to': z.object({ event_id: z.string() }) })
            .optional()
        })
        .parse(message)
    )
  ).toEqual([
    {
      body: 'answer $22',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$22' } }
    },
    {
      body: 'answer $11',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$11' } }
    },
    {
      body: 'answer $33',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$33' } }
    },
    { body: 'ordinary' }
  ])
})
