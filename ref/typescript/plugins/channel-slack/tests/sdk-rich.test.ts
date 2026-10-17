import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { assemble } from '../../channel-wecom/tests/test-support.js'
import { afterEach, expect, it } from 'vitest'
import { createSlackChannel } from '../src/index.js'
import { peer } from './peer.js'

installPeerNetwork()
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

// Protect persisted Core rich layout and SDK delegation above the former 25MiB
// And MIME preflights. Direct-send tests with tiny PNGs cannot catch a capability
// Forcing standalone delivery before send. Real SQLite and HTTP use the published
// SDK, with opaque upload bytes and no production seam or live-account claim.
// FilesUploadV2 stages: @slack/web-api 8.2.0 dist/WebClient.js filesUploadV2.
// https://docs.slack.dev/reference/methods/files.completeUploadExternal/
it('keeps a budgeted large image in Core rich blocks and delegates acceptance to the SDK', async () => {
  const remote = await peer((input) => {
    if (input.path === '/files.getUploadURLExternal') {
      return {
        body: {
          ok: true,
          upload_url: 'https://slack.com/api/upload',
          file_id: 'FLARGE'
        }
      }
    }
    if (input.path === '/files.completeUploadExternal') {
      return { body: { ok: true, files: [{ id: 'FLARGE' }] } }
    }
    return { body: { ok: true, ts: '1700000000.001' } }
  })

  cleanup.push(remote.close)

  const local = await assemble(
    createSlackChannel({ BOT: 'token', SIGN: 'secret' }),
    { botToken: { env: 'BOT' }, signingSecret: { env: 'SIGN' }, appId: 'A1' },
    [{ chatId: 'C7', senderId: 'U42' }]
  )

  const principal = local.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }

  const queued = await principal.sendMessage({
    channel,
    text: `${'a'.repeat(2501)}\n![photo](relanox://attachment/1)\nafter`,
    attachments: [
      {
        kind: 'image',
        mimeType: 'image/avif',
        fileName: 'large.avif',
        data: new Uint8Array(25 * 1024 * 1024 + 1)
      }
    ]
  })

  expect(queued.status).toBe('queued')
  if (queued.status !== 'queued') {
    throw new Error('missing_delivery')
  }
  const plan = await local.storage.getOutbound(queued.deliveryId)
  expect(plan?.chunks).toHaveLength(3)
  expect(plan?.chunks[2]?.richText?.map((part) => part.type)).toEqual([
    'text',
    'image',
    'text'
  ])
  await local.runtime.processDue()
  await local.runtime.processDue()
  await local.runtime.processDue()
  expect((await local.storage.getOutbound(queued.deliveryId))?.status).toBe(
    'sent'
  )

  const posts = remote.requests.filter(
    (item) => item.path === '/chat.postMessage'
  )

  expect(posts).toHaveLength(3)
  expect(posts[2]?.body).toMatchObject({
    blocks: [
      { type: 'rich_text' },
      { type: 'image', slack_file: { id: 'FLARGE' }, alt_text: 'photo' },
      { type: 'rich_text' }
    ]
  })
  expect(
    remote.requests.filter(
      (item) => item.path === '/files.completeUploadExternal'
    )
  ).toHaveLength(1)
})
