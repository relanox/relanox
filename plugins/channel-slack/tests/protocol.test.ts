import {
  routePlatform,
  registerPeer,
  installPeerNetwork
} from '../../channel-wecom/tests/network.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpHandler, ChannelHost, IngestInput } from '@relanox/sdk'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { createSlackChannel } from '../src/index.js'
import { peer, recorder, sendInput } from './peer.js'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'

installPeerNetwork()

const environment = {
  BOT: 'xoxb-secret',
  ROTATED: 'xoxb-rotated',
  SIGN: 'signing-secret',
  APP: 'xapp-secret'
}

const account = {
  id: 'sl',
  channel: 'slack' as const,
  config: null,
  allowedSenders: ['U42']
}

const target = {
  channel: 'slack' as const,
  accountId: 'sl',
  chatId: 'C7',
  threadId: '1700000000.001',
  replyToId: '1700000000.002',
  data: {
    teamId: 'T1',
    appId: 'A1',
    botId: 'UBOT',
    apiBaseUrl: 'https://slack.com/api'
  }
}

const event = {
  type: 'event_callback',
  team_id: 'T1',
  api_app_id: 'A1',
  event_id: 'Ev1',
  event: {
    type: 'message',
    user: 'U42',
    channel: 'C7',
    ts: '1700000000.002',
    thread_ts: '1700000000.001',
    text: 'hello'
  }
}

const cleanup: (() => Promise<void>)[] = []

function readFrame(raw: RawData): unknown {
  if (!Buffer.isBuffer(raw)) {
    throw new TypeError('unexpected_socket_frame_bytes')
  }
  return JSON.parse(raw.toString('utf8'))
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})

async function setup(
  apiBaseUrl = 'https://slack.com/api',
  socket = false,
  onIngest?: Parameters<typeof recorder>[0],
  overrides: Record<string, unknown> = {}
): Promise<{
  target: {
    data: { apiBaseUrl: string; teamId: string; appId: string; botId: string }
    channel: 'slack'
    accountId: string
    chatId: string
    threadId: string
    replyToId: string
  }
  handler: NonNullable<ReturnType<(key: string) => HttpHandler | undefined>>
  host: ChannelHost
  received: IngestInput[]
  handlers: Map<string, HttpHandler>
  connections: string[]
  plugin: ReturnType<typeof createSlackChannel>
}> {
  if (apiBaseUrl === 'https://slack.com/api') {
    const discovery = await peer(() => ({
      body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
    }))

    cleanup.push(discovery.close)
  } else {
    routePlatform('https://slack.com/api', apiBaseUrl)
  }
  const plugin = createSlackChannel(environment)
  const recorded = recorder(onIngest)
  await plugin.setup(
    recorded.host,
    account,
    plugin.validateConfig({
      botToken: { env: 'BOT' },
      appId: 'A1',
      ...overrides,
      ...(socket
        ? { appToken: { env: 'APP' } }
        : { signingSecret: { env: 'SIGN' } })
    })
  )
  return {
    plugin,
    ...recorded,
    target: { ...target, data: { ...target.data } },
    handler: recorded.handlers.get('/events') as NonNullable<
      ReturnType<typeof recorded.handlers.get>
    >
  }
}

function request(
  value: unknown,
  timestamp = String(Math.floor(Date.now() / 1000)),
  forged = false
): Request {
  const body = ` ${JSON.stringify(value)}\n`
  return new Request('https://relay.example/channels/sl/events', {
    method: 'POST',
    body,
    headers: {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': forged
        ? 'v0=bad'
        : `v0=${createHmac('sha256', 'signing-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`
    }
  })
}

describe('slack native protocol', () => {
  it('sends Markdown styles as rich text while keeping escaped literals and mention syntax ordinary text', async () => {
    const remote = await peer(() => ({
      body: { ok: true, ts: '1700000002.004' }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)
    const input = sendInput(test.target)
    expect(
      (
        await test.plugin.send({
          ...input,
          chunk: {
            ...input.chunk,
            text: '\\*literal\\* **bold** _italic_ ~~gone~~ [site](https://example.com) `x*y` <@U123>\n\n```ts\nx < y\n```'
          }
        })
      ).status
    ).toBe('sent')
    expect(remote.requests[0]?.body).toMatchObject({
      text: '*literal* bold italic gone site (https://example.com/) x*y &lt;@U123&gt;\n\nx &lt; y',
      mrkdwn: false,
      parse: 'none',
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: '*literal* ' },
                { type: 'text', text: 'bold', style: { bold: true } },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'italic', style: { italic: true } },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'gone', style: { strike: true } },
                { type: 'text', text: ' ' },
                { type: 'link', text: 'site', url: 'https://example.com/' },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'x*y', style: { code: true } },
                { type: 'text', text: ' <@U123>\n\n' }
              ]
            },
            {
              type: 'rich_text_preformatted',
              elements: [{ type: 'text', text: 'x < y' }]
            }
          ]
        }
      ]
    })
  })

  it('budgets rich-text run overhead before sending every split fragment', async () => {
    const remote = await peer(() => ({
      body: { ok: true, ts: '1700000002.004' }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)

    const parts =
      test.plugin.splitText?.('**x** '.repeat(150), test.target) ?? []

    expect(parts.length).toBeGreaterThan(1)
    for (const [index, text] of parts.entries()) {
      const input = sendInput(test.target)
      expect(
        (
          await test.plugin.send({
            ...input,
            chunkIndex: index,
            chunk: { ...input.chunk, text }
          })
        ).status
      ).toBe('sent')
    }
    for (const item of remote.requests) {
      expect(
        Buffer.byteLength(JSON.stringify(item.body), 'utf8')
      ).toBeLessThanOrEqual(4000)
    }

    const visible = remote.requests
      .map((item) => (item.body as { text: string }).text)
      .join('')

    expect(visible.replaceAll(/\s/gu, '')).toBe('x'.repeat(150))
  })

  it.each(['failed', 'incomplete'])(
    'does not mount or receive after %s authenticated identity discovery',
    async (failure) => {
      const remote = await peer(() => ({
        body: { code: 0, tenant_access_token: 'startup-token', expire: 7200 }
      }))

      cleanup.push(remote.close)
      remote.identity(
        { ok: true, user_id: '' },
        failure === 'failed' ? 503 : 200
      )
      const plugin = createSlackChannel(environment)
      const recorded = recorder()
      await expect(
        plugin.setup(
          recorded.host,
          account,
          plugin.validateConfig({
            botToken: { env: 'BOT' },
            appId: 'A1',
            signingSecret: { env: 'SIGN' }
          })
        )
      ).rejects.toThrow()
      expect(recorded.handlers.size).toBe(0)
      expect(recorded.received).toEqual([])
      expect(recorded.connections).not.toContain('connected')
      expect(remote.discoveryRequests.length).toBeGreaterThan(0)
    }
  )

  it('validates minimal credentials offline without identity traffic', async () => {
    const remote = await peer(() => ({ body: {} }))
    cleanup.push(remote.close)
    expect(
      createSlackChannel(environment).validateConfig({
        botToken: { env: 'BOT' },
        appId: 'A1',
        signingSecret: { env: 'SIGN' }
      })
    ).toEqual({
      botToken: { env: 'BOT' },
      appId: 'A1',
      signingSecret: { env: 'SIGN' }
    })
    expect(remote.discoveryRequests).toEqual([])
    expect(remote.requests).toEqual([])
  })

  it.each(['sender_not_allowed', 'unbound_conversation'])(
    'acknowledges terminal core policy rejection: %s',
    async (code) => {
      const test = await setup(undefined, false, async () => {
        throw Object.assign(new Error(code), { code })
      })

      expect((await test.handler(request(event))).status).toBe(204)
      expect(test.received).toEqual([])
    }
  )

  it.each(['identity', 'server', 'legacy'])(
    'refuses a frozen target after %s changes',
    async (change) => {
      const remote = await peer(() => ({
        body: { ok: true, ts: '1700000002.004' }
      }))

      cleanup.push(remote.close)
      const initial = await setup(remote.url)
      await initial.handler(request(event))
      const frozen = initial.received[0]?.target
      if (!frozen) {
        throw new Error('Missing accepted reply target')
      }

      if (change === 'identity') {
        remote.identity({ user_id: 'UOTHER' })
      }

      const nextBase =
        change === 'server' ? `${remote.url}/different` : remote.url

      const restarted = await setup(nextBase, false, undefined, {})

      let replyTarget = frozen
      if (change === 'legacy') {
        replyTarget = { ...frozen, data: { teamId: 'T1' } }
      }
      if (change === 'server') {
        replyTarget = {
          ...frozen,
          data: { ...target.data, apiBaseUrl: 'https://foreign.example' }
        }
      }

      expect(await restarted.plugin.send(sendInput(replyTarget))).toEqual({
        status: 'rejected',
        errorCode: 'invalid_target'
      })
      expect(remote.requests).toEqual([])
    }
  )

  it('keeps same-identity credential rotation and canonical URL spelling deliverable', async () => {
    const remote = await peer(() => ({
      body: { ok: true, ts: '1700000002.004' }
    }))

    cleanup.push(remote.close)
    const initial = await setup(remote.url)

    const restarted = await setup(`${remote.url}/`, false, undefined, {
      botToken: { env: 'ROTATED' }
    })

    expect(
      (await restarted.plugin.send(sendInput(initial.target))).status
    ).toBe('sent')
    expect(remote.requests).toHaveLength(1)
  })

  it('bounds event bodies and preserves canceled-send uncertainty', async () => {
    const remote = await peer(() => ({
      body: { ok: true, ts: '1700000002.004' }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)

    const oversized = new Request('https://relay.example/channels/sl/events', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000))
      },
      body: 'x'.repeat(1_048_577)
    })

    expect((await test.handler(oversized)).status).toBe(413)
    expect(test.received).toEqual([])
    const controller = new AbortController()
    controller.abort()
    expect(
      await test.plugin.send(sendInput(test.target, controller.signal))
    ).toEqual({
      status: 'unknown',
      errorCode: 'slack_transport_error'
    })
    expect(remote.requests).toEqual([])
  })

  it('verifies raw bytes/freshness and echoes authenticated URL verification', async () => {
    const test = await setup()
    expect((await test.handler(request(event, undefined, true))).status).toBe(
      401
    )
    expect((await test.handler(request(event, '1000000000'))).status).toBe(401)
    expect(test.received).toEqual([])
    expect(
      await (
        await test.handler(
          request({ type: 'url_verification', challenge: 'challenge-42' })
        )
      ).json()
    ).toEqual({ challenge: 'challenge-42' })
    expect((await test.handler(request(event))).status).toBe(204)
    expect(test.received[0]).toMatchObject({
      source: { channel: 'slack', accountId: 'sl' },
      senderId: 'U42',
      target,
      context: { teamId: 'T1' }
    })
  })

  it('rejects wrong workspace and suppresses bot/subtype loops', async () => {
    const test = await setup()
    expect(
      (await test.handler(request({ ...event, team_id: 'T2' }))).status
    ).toBe(401)
    expect(
      (
        await test.handler(
          request({ ...event, event: { ...event.event, bot_id: 'B1' } })
        )
      ).status
    ).toBe(204)
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: { ...event.event, subtype: 'message_changed' }
          })
        )
      ).status
    ).toBe(204)
    expect(test.received).toHaveLength(0)
  })

  // Native human message fields: https://github.com/slackapi/node-slack-sdk/blob/e02e7feeb500bfde1f947401a639633e42ce2f91/packages/types/src/events/message.ts
  it.each([
    { subtype: 'me_message', threadId: undefined, outerThread: false },
    {
      subtype: 'thread_broadcast',
      threadId: '1700000000.001',
      outerThread: true
    },
    {
      subtype: 'thread_broadcast',
      threadId: '1700000000.001',
      outerThread: false
    }
  ])(
    'receives native human $subtype messages at their original address (outer thread: $outerThread)',
    async ({ subtype, threadId, outerThread }) => {
      const test = await setup()
      const { thread_ts: _thread, ...message } = event.event
      expect(
        (
          await test.handler(
            request({
              ...event,
              event: {
                ...message,
                subtype,
                channel_type: 'channel',
                event_ts: '1700000000.002',
                ...(threadId
                  ? {
                      ...(outerThread ? { thread_ts: threadId } : {}),
                      client_msg_id: '9b3f2ca4-46c6-4dbc-a0f5-5576033c55d3',
                      root: {
                        type: 'message',
                        event_ts: threadId,
                        channel: 'C7',
                        channel_type: 'channel',
                        user: 'U42',
                        text: 'root',
                        ts: threadId,
                        thread_ts: threadId,
                        reply_count: 1,
                        reply_users_count: 1,
                        latest_reply: '1700000000.002',
                        reply_users: ['U42']
                      }
                    }
                  : {})
              }
            })
          )
        ).status
      ).toBe(204)
      expect(test.received).toHaveLength(1)
      expect(test.received[0]).toMatchObject({
        source: { channel: 'slack', accountId: 'sl', eventId: 'Ev1' },
        senderId: 'U42',
        text: 'hello',
        target: { chatId: 'C7', replyToId: '1700000000.002' }
      })
      expect(test.received[0]?.target.threadId).toBe(threadId)
    }
  )

  it('receives a native file with a null name using its file ID without dropping the message', async () => {
    const download = await mediaPeer(() => ({
      data: Uint8Array.of(104, 101, 108, 108, 111),
      mimeType: 'text/plain'
    }))

    cleanup.push(download.close)
    routePlatform('https://files.slack.com', registerPeer(download.origin))
    const test = await setup()
    // The native message File contract above explicitly permits name: string | null.
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: {
              ...event.event,
              subtype: 'file_share',
              files: [
                {
                  id: 'F123',
                  created: 1_700_000_000,
                  name: null,
                  title: null,
                  mimetype: 'text/plain',
                  filetype: 'text',
                  pretty_type: 'Plain Text',
                  user: 'U42',
                  editable: false,
                  size: 5,
                  mode: 'hosted',
                  is_external: false,
                  external_type: null,
                  is_public: false,
                  public_url_shared: false,
                  display_as_bot: false,
                  username: null,
                  permalink: 'https://workspace.slack.com/files/U42/F123',
                  channels: ['C7'],
                  groups: [],
                  url_private_download:
                    'https://files.slack.com/files-pri/T1-F123/download'
                }
              ]
            }
          })
        )
      ).status
    ).toBe(204)
    expect(test.received).toHaveLength(1)
    expect(test.received[0]?.attachments).toMatchObject([
      {
        kind: 'file',
        mimeType: 'text/plain',
        fileName: 'F123'
      }
    ])
    expect([...(test.received[0]?.attachments?.[0]?.data ?? [])]).toEqual([
      104, 101, 108, 108, 111
    ])
    expect(download.traffic).toMatchObject([
      {
        method: 'GET',
        path: '/files-pri/T1-F123/download',
        headers: { authorization: 'Bearer xoxb-secret' }
      }
    ])
  })

  it('does not acknowledge failed HTTP handoff', async () => {
    const test = await setup(undefined, false, async () => {
      throw new Error('storage down')
    })

    expect((await test.handler(request(event))).status).toBe(503)
  })

  it('uses bot-token independent plain-text thread send', async () => {
    const remote = await peer(() => ({
      body: { ok: true, ts: '1700000002.004' }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)
    expect(await test.plugin.send(sendInput(test.target))).toEqual({
      status: 'sent',
      receipt: { platformMessageId: '1700000002.004' }
    })
    expect(remote.requests[0]).toMatchObject({
      path: '/chat.postMessage',
      headers: { authorization: 'Bearer xoxb-secret' },
      body: {
        channel: 'C7',
        text: 'hello @everyone &lt;@U123&gt;',
        thread_ts: '1700000000.001',
        mrkdwn: false,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false
      }
    })
  })

  it.each([
    {
      status: 200,
      body: { ok: false, error: 'channel_not_found' },
      headers: {},
      expected: { status: 'rejected', errorCode: 'slack_api_error' }
    },
    {
      status: 429,
      body: { ok: false },
      headers: { 'retry-after': '3' },
      expected: {
        status: 'retryable',
        errorCode: 'rate_limited',
        retryAfterMs: 3000
      }
    },
    {
      status: 200,
      body: { ok: false, error: 'internal_error' },
      headers: {},
      expected: { status: 'unknown', errorCode: 'slack_api_error' }
    }
  ])('maps Web API errors', async ({ status, body, headers, expected }) => {
    const remote = await peer(() => ({ status, body, headers }))
    cleanup.push(remote.close)
    const test = await setup(remote.url)
    expect(await test.plugin.send(sendInput(test.target))).toEqual(expected)
  })

  it('opens Socket Mode with app token, ACKs only after ingest and reconnects on disconnect', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => {
      wss.once('listening', resolve)
    })

    const wsUrl = registerPeer(
      `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
    ).replace('https:', 'wss:')

    const frames: unknown[] = []
    let connected = 0
    const remote = await peer(() => ({ body: { ok: true, url: wsUrl } }))
    let release: (() => void) | undefined

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const test = await setup(remote.url, true, async () => gate)
    cleanup.push(async () => {
      await test.plugin.stop?.()
      for (const ws of wss.clients) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      })
      await remote.close()
    })
    wss.on('connection', (ws) => {
      connected++
      ws.send(JSON.stringify({ type: 'hello' }))
      if (connected === 1) {
        ws.send(
          JSON.stringify({
            type: 'events_api',
            envelope_id: 'envelope-42',
            payload: event
          })
        )
      }
      ws.on('message', (raw) => frames.push(readFrame(raw)))
    })
    await test.plugin.start?.(new AbortController().signal)
    await expect.poll(() => remote.requests.length).toBe(1)
    expect(remote.requests[0]?.headers.authorization).toBe('Bearer xapp-secret')
    await expect.poll(() => test.connections.includes('connected')).toBe(true)
    expect(frames).toHaveLength(0)
    release?.()
    await expect
      .poll(() => frames)
      .toContainEqual({ envelope_id: 'envelope-42' })
    expect(test.received).toHaveLength(1)
    for (const ws of wss.clients) {
      ws.send(
        JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })
      )
    }
    await expect.poll(() => connected, { timeout: 3000 }).toBe(2)
    await test.plugin.stop?.()
    const stopped = connected
    await new Promise((resolve) => {
      setTimeout(resolve, 180)
    })
    expect(connected).toBe(stopped)
  })

  it('closes failed Socket Mode handoff without ACK', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => {
      wss.once('listening', resolve)
    })

    const remote = await peer(() => ({
      body: {
        ok: true,
        url: registerPeer(
          `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
        ).replace('https:', 'wss:')
      }
    }))

    const frames: unknown[] = []

    // Socket envelope shape: https://github.com/slackapi/node-slack-sdk/blob/e02e7feeb500bfde1f947401a639633e42ce2f91/packages/socket-mode/src/SocketModeClient.ts
    let attempted = false

    const test = await setup(remote.url, true, async () => {
      attempted = true
      throw new Error('failed commit')
    })

    cleanup.push(async () => {
      await test.plugin.stop?.()
      for (const ws of wss.clients) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      })
      await remote.close()
    })
    wss.on('connection', (ws) => {
      ws.send(
        JSON.stringify({
          type: 'events_api',
          envelope_id: 'failed-envelope',
          payload: event
        })
      )
      ws.on('message', (raw) => frames.push(readFrame(raw)))
    })
    await test.plugin.start?.(new AbortController().signal)
    await expect.poll(() => attempted).toBe(true)
    await expect.poll(() => test.connections.includes('degraded')).toBe(true)
    await test.plugin.stop?.()
    expect(frames).toEqual([])
    expect(test.received).toEqual([])
  })

  it('rejects literal credentials, remote cleartext URLs and foreign targets', async () => {
    const plugin = createSlackChannel(environment)
    expect(() =>
      plugin.validateConfig({ receiveMode: 'socket', botToken: 'raw' })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        receiveMode: 'http',
        signingSecret: { env: 'SIGN' },
        botToken: { env: 'BOT' },
        botUserId: 'UBOT',
        teamId: 'T1',
        appId: 'A1',
        apiBaseUrl: 'http://remote.example'
      })
    ).toThrow()
    const test = await setup()
    expect(
      await test.plugin.send(
        sendInput({
          ...test.target,
          data: { ...test.target.data, teamId: 'T2' }
        })
      )
    ).toEqual({
      status: 'rejected',
      errorCode: 'invalid_target'
    })
  })
})

it('keeps authenticated top-level messages in the configured channel without inventing a thread from the message ID', async () => {
  const local = await setup()
  const { thread_ts: _thread, ...topLevel } = event.event
  expect(
    (await local.handler(request({ ...event, event: topLevel }))).status
  ).toBe(204)
  expect(local.received[0]?.target.chatId).toBe('C7')
  expect(local.received[0]?.target.threadId).toBeUndefined()
  expect(
    await local.plugin.resolveChannel?.(
      { id: 'channel', platform: 'slack', accountId: 'sl', chatId: 'C7' },
      local.received[0]?.target
    )
  ).toMatchObject({
    status: 'available',
    target: { chatId: 'C7' }
  })
})

const richImage = {
  reference: {
    id: 'image-1',
    kind: 'image' as const,
    mimeType: 'image/png',
    fileName: 'photo.png',
    size: 5,
    sha256: '0'.repeat(64)
  },
  data: new Uint8Array([1, 2, 3, 4, 5])
}

it('uploads images privately and posts ordered rich blocks in the same Slack thread', async () => {
  const remote = await peer((input) => {
    if (input.path === '/files.getUploadURLExternal') {
      return {
        body: {
          ok: true,
          upload_url: 'https://slack.com/api/upload',
          file_id: 'F1'
        }
      }
    }
    if (input.path === '/upload') {
      return { body: {} }
    }
    if (input.path === '/files.completeUploadExternal') {
      return { body: { ok: true, files: [{ id: 'F1' }] } }
    }
    return { body: { ok: true, ts: 'sent' } }
  })

  cleanup.push(remote.close)
  const local = await setup(remote.url)

  const input = {
    ...sendInput(local.target),
    chunk: {
      text: '',
      state: null,
      idempotencyKey: 'rich',
      richText: [
        { type: 'text' as const, text: '**before**' },
        { type: 'image' as const, media: richImage.reference, label: 'photo' },
        { type: 'text' as const, text: 'after' }
      ]
    },
    richMedia: [richImage]
  }

  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(remote.requests.map((item) => item.path)).toEqual([
    '/files.getUploadURLExternal',
    '/upload',
    '/files.completeUploadExternal',
    '/chat.postMessage'
  ])
  expect(remote.requests[2]?.body).toEqual({
    files: [{ id: 'F1', title: 'photo.png' }]
  })
  expect(remote.requests[3]).toMatchObject({
    headers: { authorization: 'Bearer xoxb-secret' },
    body: {
      thread_ts: '1700000000.001',
      blocks: [
        { type: 'rich_text' },
        { type: 'image', slack_file: { id: 'F1' }, alt_text: 'photo' },
        { type: 'rich_text' }
      ]
    }
  })
  const count = remote.requests.length
  expect(await local.plugin.send({ ...input, richMedia: [] })).toEqual({
    status: 'rejected',
    errorCode: 'invalid_rich_media'
  })
  expect(
    await local.plugin.send({
      ...input,
      chunk: {
        ...input.chunk,
        richText: [
          { type: 'text', text: 'a'.repeat(2501) },
          { type: 'image', media: richImage.reference, label: 'photo' }
        ]
      }
    })
  ).toEqual({ status: 'rejected', errorCode: 'rich_text_limit_exceeded' })
  expect(remote.requests).toHaveLength(count)
})

it('does not post a rich Slack message when native file completion is rejected', async () => {
  const remote = await peer((captured) => {
    if (captured.path === '/files.getUploadURLExternal') {
      return {
        body: {
          ok: true,
          upload_url: 'https://slack.com/api/upload',
          file_id: 'F1'
        }
      }
    }
    if (captured.path === '/upload') {
      return { body: {} }
    }
    return { body: { ok: false, error: 'file_type_not_allowed' } }
  })

  cleanup.push(remote.close)
  const local = await setup(remote.url)
  expect(
    await local.plugin.send({
      ...sendInput(local.target),
      chunk: {
        text: '',
        state: null,
        idempotencyKey: 'rich-failure',
        richText: [
          { type: 'image', media: richImage.reference, label: 'photo' }
        ]
      },
      richMedia: [richImage]
    })
  ).toMatchObject({ status: 'rejected' })
  expect(remote.requests.map((captured) => captured.path)).toEqual([
    '/files.getUploadURLExternal',
    '/upload',
    '/files.completeUploadExternal'
  ])
})
