import { expect, it } from 'vitest'
import { z } from 'zod'
import { assemble, records } from '../../channel-wecom/tests/test-support.js'
import { cleanup } from '../../channel-matrix/tests/harness.js'
import { peer } from './peer.js'
import { createTelegramChannel } from '../src/index.js'

// Telegram Bot API Message/reply_parameters:
// https://core.telegram.org/bots/api#message
// https://core.telegram.org/bots/api#replyparameters
// Protects persisted request selection through Core; direct plugin.send tests cannot
// Detect a resolver dropping the selected ID or quoting the latest ordinary send.
// Uses the production AgentHost and SQLite, without a production-only testing seam.
it('quotes three selected requests out of order and leaves ordinary sends unquoted', async () => {
  const remote = await peer(() => ({
    body: { ok: true, result: { message_id: 100 } }
  }))

  cleanup(remote.close)
  const plugin = createTelegramChannel({ TOKEN: '123:token', SECRET: 'secret' })

  const fixture = await assemble(
    plugin,
    {
      botToken: { env: 'TOKEN' },
      webhookSecret: { env: 'SECRET' },
      apiBaseUrl: remote.url,
      allowInsecureLoopback: true
    },
    [{ chatId: '-1007', senderId: '42' }]
  )

  for (const id of [11, 22, 33]) {
    const response = await fixture.runtime.fetch(
      new Request('https://relay.example/channels/bot/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'secret' },
        body: JSON.stringify({
          update_id: id,
          message: {
            message_id: id,
            from: { id: 42, is_bot: false },
            chat: { id: -1007, type: 'supergroup' },
            text: `question ${id}`
          }
        })
      })
    )

    expect(response.status).toBe(204)
  }
  const received = await records(fixture.storage)
  expect(received).toHaveLength(3)
  for (const id of [22, 11, 33]) {
    const request = received.find(
      (item) => item.snapshot.target.replyToId === String(id)
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

  const messages = remote.requests.map((request) =>
    z
      .object({
        text: z.string(),
        reply_parameters: z.object({ message_id: z.number() }).optional()
      })
      .parse(request.body)
  )

  expect(messages).toEqual([
    { text: 'answer 22', reply_parameters: { message_id: 22 } },
    { text: 'answer 11', reply_parameters: { message_id: 11 } },
    { text: 'answer 33', reply_parameters: { message_id: 33 } },
    { text: 'ordinary' }
  ])
})
