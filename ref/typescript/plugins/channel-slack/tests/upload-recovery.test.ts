import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it } from 'vitest'
import { createSlackChannel } from '../src/index.js'
import { assemble } from '../../channel-wecom/tests/test-support.js'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

type Failure =
  | 'upload 503'
  | 'upload connection loss'
  | 'upload URL internal error'
  | 'upload 413'
  | 'completion 503'
  | 'completion connection loss'
  | 'completion internal error'

// Slack requires getUploadURLExternal, the binary upload, then completion.
// Without completion, uploaded bytes cannot publish a channel message:
// https://docs.slack.dev/reference/methods/files.getUploadURLExternal/
// https://docs.slack.dev/reference/methods/files.completeUploadExternal/
// The official filesUploadV2 implementation owns all three protocol steps:
// https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/WebClient.ts
async function queuedUpload(failure: Failure): Promise<{
  runtime: Awaited<ReturnType<typeof assemble>>['runtime']
  remote: Awaited<ReturnType<typeof mediaPeer>>
}> {
  let failed = false

  const remote = await mediaPeer((traffic) => {
    if (traffic.path === '/auth.test') {
      return {
        json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' }
      }
    }
    if (traffic.path === '/files.getUploadURLExternal') {
      if (failure === 'upload URL internal error' && !failed) {
        failed = true
        return { json: { ok: false, error: 'internal_error' } }
      }
      return {
        json: {
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/external',
          file_id: 'FGENERATED'
        }
      }
    }
    if (traffic.path === '/upload/v1/external') {
      if (failure === 'upload 413') {
        return { status: 413 }
      }
      if (
        failure.startsWith('upload ') &&
        failure !== 'upload URL internal error' &&
        !failed
      ) {
        failed = true
        return failure === 'upload connection loss'
          ? { drop: true }
          : { status: 503 }
      }
      return { status: 200 }
    }
    if (failure === 'completion internal error') {
      return { json: { ok: false, error: 'internal_error' } }
    }
    if (failure.startsWith('completion ')) {
      return failure === 'completion connection loss'
        ? { drop: true }
        : { status: 503 }
    }
    return { json: { ok: true, files: [{ id: 'FGENERATED' }] } }
  })

  cleanup.push(remote.close)
  const url = registerPeer(remote.origin)
  routePlatform('https://slack.com', url)
  routePlatform('https://files.slack.com', url)

  const local = await assemble(
    createSlackChannel({ BOT: 'bot-token', SIGN: 'signing-secret' }),
    {
      botToken: { env: 'BOT' },
      signingSecret: { env: 'SIGN' },
      appId: 'A1'
    },
    [{ chatId: 'C7', senderId: 'U42' }]
  )

  const principal = local.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_bound_channel')
  }
  expect(
    await principal.sendMessage({
      channel,
      text: '',
      attachments: [
        {
          kind: 'audio',
          mimeType: 'audio/mpeg',
          fileName: 'answer.mp3',
          data: Uint8Array.of(1, 2, 3)
        }
      ]
    })
  ).toMatchObject({ status: 'queued' })
  return { runtime: local.runtime, remote }
}

// Recovery uses real SQLite; the peer only records and answers Slack HTTP.
// A whole-upload unknown classification loses these safe Core retries. Existing
// Positive upload cases cannot distinguish transfer from channel publication.
it.each([
  'upload 503',
  'upload connection loss',
  'upload URL internal error'
] as const)(
  'retries %s through Core before one successful completion',
  async (failure) => {
    const local = await queuedUpload(failure)
    await local.runtime.processDue()
    expect((await local.runtime.status()).deliveries[0]?.status).toBe('pending')
    expect(
      local.remote.traffic.filter(
        (item) => item.path === '/files.completeUploadExternal'
      )
    ).toEqual([])
    await expect
      .poll(
        async () => {
          await local.runtime.processDue()
          return (await local.runtime.status()).deliveries[0]?.status
        },
        { timeout: 5000 }
      )
      .toBe('sent')
    expect(
      local.remote.traffic.filter(
        (item) => item.path === '/files.getUploadURLExternal'
      )
    ).toHaveLength(2)
    expect(
      local.remote.traffic.filter((item) => item.path === '/upload/v1/external')
    ).toHaveLength(failure === 'upload URL internal error' ? 1 : 2)
    expect(
      local.remote.traffic.filter(
        (item) => item.path === '/files.completeUploadExternal'
      )
    ).toHaveLength(1)
  }
)

it.each([
  'completion 503',
  'completion connection loss',
  'completion internal error'
] as const)(
  'keeps %s unknown without replaying publication',
  async (failure) => {
    const local = await queuedUpload(failure)
    await local.runtime.processDue()
    expect((await local.runtime.status()).deliveries[0]?.status).toBe('unknown')
    await local.runtime.processDue()
    expect(
      local.remote.traffic.filter(
        (item) => item.path === '/files.getUploadURLExternal'
      )
    ).toHaveLength(1)
    expect(
      local.remote.traffic.filter((item) => item.path === '/upload/v1/external')
    ).toHaveLength(1)
    expect(
      local.remote.traffic.filter(
        (item) => item.path === '/files.completeUploadExternal'
      )
    ).toHaveLength(1)
  }
)

it('keeps a refused upload rejected without trying completion or replaying it', async () => {
  const local = await queuedUpload('upload 413')
  await local.runtime.processDue()
  expect((await local.runtime.status()).deliveries[0]?.status).toBe('rejected')
  await local.runtime.processDue()
  expect(
    local.remote.traffic.filter((item) => item.path === '/upload/v1/external')
  ).toHaveLength(1)
  expect(
    local.remote.traffic.filter(
      (item) => item.path === '/files.completeUploadExternal'
    )
  ).toEqual([])
})
