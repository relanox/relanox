import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'
import { fixture } from './authorization-runtime.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Native callback fields: https://docs.slack.dev/apis/events-api/
// https://docs.slack.dev/reference/events/message.channels/
// https://docs.slack.dev/reference/events/app_mention/
// When both subscriptions are enabled, Slack sends both types for one mention:
// https://github.com/slackapi/bolt-js/issues/414#issuecomment-889053547
// https://github.com/slackapi/bolt-python/issues/1451
function envelope(
  type: 'message' | 'app_mention',
  eventId: string,
  ts: string,
  channel = 'C7'
): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: eventId,
    event: {
      type,
      user: 'U42',
      channel,
      channel_type: 'channel',
      ts,
      event_ts: ts,
      text: '<@UBOT> question'
    }
  }
}

async function deliver(origin: string, body: unknown): Promise<Response> {
  const content = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  return fetch(`${origin}/channels/sl/events`, {
    method: 'POST',
    body: content,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${timestamp}:${content}`).digest('hex')}`
    }
  })
}

it('persists one request per posted Slack mention across both event types and a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-slack-identity-'))
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))

  const remote = await mediaPeer((traffic) =>
    traffic.path === '/auth.test'
      ? { json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' } }
      : { status: 404 }
  )

  cleanup.push(remote.close)
  routePlatform('https://slack.com', registerPeer(remote.origin))

  const filename = join(directory, 'relay.sqlite')
  const first = await fixture(filename, cleanup, false, {}, ['C7', 'C8'])
  const original = envelope('message', 'EvMessage', '1700000000.002')
  const mention = envelope('app_mention', 'EvMention', '1700000000.002')

  expect((await deliver(first.origin, original)).status).toBe(204)
  expect((await deliver(first.origin, mention)).status).toBe(204)
  expect((await first.core.status()).requests).toHaveLength(1)

  await first.storage.close()
  const restarted = await fixture(filename, cleanup, false, {}, ['C7', 'C8'])
  expect(
    (
      await deliver(
        restarted.origin,
        envelope('app_mention', 'EvMentionAgain', '1700000000.002')
      )
    ).status
  ).toBe(204)
  expect((await restarted.core.status()).requests).toHaveLength(1)

  const nextMention = envelope('app_mention', 'EvNextMention', '1700000000.003')
  const nextMessage = envelope('message', 'EvNextMessage', '1700000000.003')
  expect((await deliver(restarted.origin, nextMention)).status).toBe(204)
  expect((await deliver(restarted.origin, nextMessage)).status).toBe(204)
  expect((await restarted.core.status()).requests).toHaveLength(2)

  const anotherChannel = envelope(
    'message',
    'EvOtherChannel',
    '1700000000.003',
    'C8'
  )

  expect((await deliver(restarted.origin, anotherChannel)).status).toBe(204)
  expect((await restarted.core.status()).requests).toHaveLength(3)
})
