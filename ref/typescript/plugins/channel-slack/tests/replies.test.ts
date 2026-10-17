import { createHmac } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createSlackChannel } from '../src/index.js'
import { assemble } from '../../channel-wecom/tests/test-support.js'
import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { peer } from './peer.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})

// Slack's native reply is thread_ts, using the root ts rather than a reply ts:
// https://docs.slack.dev/reference/methods/chat.postMessage/
it('replies to three selected durable requests out of order and leaves ordinary messages unthreaded', async () => {
  const remote = await peer(() => ({
    body: { ok: true, ts: '1800000001.001' }
  }))

  cleanup.push(remote.close)

  const local = await assemble(
    createSlackChannel({ BOT: 'bot-token', SIGN: 'signing-secret' }),
    {
      botToken: { env: 'BOT' },
      signingSecret: { env: 'SIGN' },
      appId: 'A1'
    },
    [{ chatId: 'C7', senderId: 'U42' }]
  )

  for (const ts of ['1800000000.001', '1800000000.002', '1800000000.003']) {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: `Ev${ts}`,
      event: { type: 'message', user: 'U42', channel: 'C7', ts, text: ts }
    })

    const timestamp = String(Math.floor(Date.now() / 1000))

    const signature = createHmac('sha256', 'signing-secret')
      .update(`v0:${timestamp}:${body}`)
      .digest('hex')

    expect(
      (
        await local.runtime.fetch(
          new Request('https://relay.example/channels/bot/events', {
            method: 'POST',
            headers: {
              'x-slack-request-timestamp': timestamp,
              'x-slack-signature': `v0=${signature}`
            },
            body
          })
        )
      ).status
    ).toBe(204)
  }
  const requests = await local.storage.listInbound({ limit: 10 })
  expect(requests).toHaveLength(3)
  const principal = local.principal()
  for (const text of ['1800000000.002', '1800000000.001', '1800000000.003']) {
    const request = requests.find(
      (item) => item.snapshot.text === text
    )?.snapshot

    if (!request) {
      throw new Error('missing_incoming_request')
    }
    expect(
      await principal.sendMessage({
        channel: request.channel.id,
        text: `answer ${text}`,
        reply: { requestId: request.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await local.runtime.processDue()
  }
  const channel = requests[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await principal.sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({
    status: 'queued'
  })
  await local.runtime.processDue()
  expect(remote.requests.map((request) => request.body)).toMatchObject([
    { text: 'answer 1800000000.002', thread_ts: '1800000000.002' },
    { text: 'answer 1800000000.001', thread_ts: '1800000000.001' },
    { text: 'answer 1800000000.003', thread_ts: '1800000000.003' },
    { text: 'ordinary' }
  ])
  expect(remote.requests[3]?.body).not.toHaveProperty('thread_ts')
})
