import { storedChannel } from './storage-peer.js'
import {
  routePlatform,
  installPeerNetwork
} from '../../channel-wecom/tests/network.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpHandler, ChannelHost, IngestInput } from '@relanox/sdk'
import { createCipheriv, createHash } from 'node:crypto'
import { createFeishuChannel } from '../src/index.js'
import { peer, recorder, sendInput } from './peer.js'

installPeerNetwork()

const environment = {
  APPSECRET: 'app-secret',
  ROTATED: 'rotated-secret',
  ENCRYPT: 'encrypt-key',
  VERIFY: 'verification-token'
}

const account = {
  id: 'fs',
  channel: 'feishu' as const,
  config: null,
  allowedSenders: ['ou_user']
}

const target = {
  channel: 'feishu' as const,
  accountId: 'fs',
  chatId: 'oc_chat',
  threadId: 'omt_thread',
  replyToId: 'om_message',
  data: {
    tenantKey: 'tenant-1',
    appId: 'cli_app',
    botId: 'ou_bot',
    apiBaseUrl: 'https://open.feishu.cn'
  }
}

const event = {
  schema: '2.0',
  header: {
    event_id: 'event-42',
    event_type: 'im.message.receive_v1',
    app_id: 'cli_app',
    tenant_key: 'tenant-1',
    token: 'verification-token'
  },
  event: {
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_user' },
      tenant_key: 'tenant-1'
    },
    message: {
      message_id: 'om_message',
      chat_id: 'oc_chat',
      chat_type: 'group',
      message_type: 'text',
      content: '{"text":"hello"}',
      create_time: '1700000000000',
      thread_id: 'omt_thread'
    }
  }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})

async function setup(
  apiBaseUrl = 'https://open.feishu.cn',
  onIngest?: Parameters<typeof recorder>[0],
  overrides: Record<string, unknown> = {}
): Promise<{
  target: {
    data: {
      apiBaseUrl: string
      tenantKey: string
      appId: string
      botId: string
    }
    channel: 'feishu'
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
  plugin: ReturnType<typeof createFeishuChannel>
}> {
  if (apiBaseUrl === 'https://open.feishu.cn') {
    const discovery = await peer(() => ({
      body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
    }))

    cleanup.push(discovery.close)
  } else {
    routePlatform('https://open.feishu.cn', apiBaseUrl)
  }
  const plugin = createFeishuChannel(environment)
  const recorded = recorder(onIngest)
  await plugin.setup(
    recorded.host,
    account,
    plugin.validateConfig({
      appId: 'cli_app',
      appSecret: { env: 'APPSECRET' },
      encryptKey: { env: 'ENCRYPT' },
      verificationToken: { env: 'VERIFY' },
      tenantKey: 'tenant-1',
      ...overrides
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
  encrypted = false,
  forged = false,
  timestamp = String(Math.floor(Date.now() / 1000))
): Request {
  let body = JSON.stringify(value)
  if (encrypted) {
    const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

    const cipher = createCipheriv(
      'aes-256-cbc',
      createHash('sha256').update('encrypt-key').digest(),
      iv
    )

    body = JSON.stringify({
      encrypt: Buffer.concat([
        iv,
        cipher.update(body, 'utf8'),
        cipher.final()
      ]).toString('base64')
    })
  }

  const signature = createHash('sha256')
    .update(`${timestamp}nonce-1encrypt-key${body}`)
    .digest('hex')

  return new Request('https://relay.example/channels/fs/events', {
    method: 'POST',
    body,
    headers: {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': 'nonce-1',
      'x-lark-signature': forged ? 'bad-signature' : signature
    }
  })
}

describe('feishu native HTTP protocol', () => {
  it.each(['failed', 'incomplete'])(
    'does not mount or receive after %s authenticated identity discovery',
    async (failure) => {
      const remote = await peer(() => ({
        body: { code: 0, tenant_access_token: 'startup-token', expire: 7200 }
      }))

      cleanup.push(remote.close)
      remote.identity({ code: 0, bot: {} }, failure === 'failed' ? 503 : 200)
      const plugin = createFeishuChannel(environment)
      const recorded = recorder()
      await expect(
        plugin.setup(
          recorded.host,
          account,
          plugin.validateConfig({
            appId: 'cli_app',
            appSecret: { env: 'APPSECRET' },
            encryptKey: { env: 'ENCRYPT' },
            verificationToken: { env: 'VERIFY' },
            tenantKey: 'tenant-1'
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
      createFeishuChannel(environment).validateConfig({
        appId: 'cli_app',
        appSecret: { env: 'APPSECRET' },
        encryptKey: { env: 'ENCRYPT' },
        verificationToken: { env: 'VERIFY' },
        tenantKey: 'tenant-1'
      })
    ).toMatchObject({
      appId: 'cli_app',
      appSecret: { env: 'APPSECRET' },
      encryptKey: { env: 'ENCRYPT' },
      verificationToken: { env: 'VERIFY' },
      tenantKey: 'tenant-1'
    })
    expect(remote.discoveryRequests).toEqual([])
    expect(remote.requests).toEqual([])
  })

  it.each(['sender_not_allowed', 'unbound_conversation'])(
    'acknowledges terminal core policy rejection: %s',
    async (code) => {
      const test = await setup(undefined, async () => {
        throw Object.assign(new Error(code), { code })
      })

      expect((await test.handler(request(event))).status).toBe(200)
      expect(test.received).toEqual([])
    }
  )

  it.each(['identity', 'server', 'legacy'])(
    'refuses a frozen target after %s changes',
    async (change) => {
      const remote = await peer((input) => ({
        body: input.path.includes('tenant_access_token')
          ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
          : { code: 0, data: { message_id: 'om_sent' } }
      }))

      cleanup.push(remote.close)
      const initial = await setup(remote.url)
      await initial.handler(request(event))
      const frozen = initial.received[0]?.target
      if (!frozen) {
        throw new Error('Missing accepted reply target')
      }

      const nextBase =
        change === 'server' ? `${remote.url}/different` : remote.url

      const restarted = await setup(
        nextBase,
        undefined,
        change === 'identity' ? { appId: 'cli_other' } : {}
      )

      let replyTarget = frozen
      if (change === 'legacy') {
        replyTarget = { ...frozen, data: { tenantKey: 'tenant-1' } }
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

  it.each([false, true])(
    'accepts unsigned token-authenticated URL challenges (encrypted=%s)',
    async (encrypted) => {
      const test = await setup()

      const challenge = {
        type: 'url_verification',
        token: 'verification-token',
        challenge: 'registration-42'
      }

      const signed = request(challenge, encrypted)

      const unsigned = new Request(signed.url, {
        method: 'POST',
        body: await signed.text()
      })

      const response = await test.handler(unsigned)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ challenge: 'registration-42' })
      const wrong = request({ ...challenge, token: 'wrong-token' }, encrypted)
      expect(
        (
          await test.handler(
            new Request(wrong.url, { method: 'POST', body: await wrong.text() })
          )
        ).status
      ).toBe(401)
      const unsignedEvent = request(event, encrypted)
      expect(
        (
          await test.handler(
            new Request(unsignedEvent.url, {
              method: 'POST',
              body: await unsignedEvent.text()
            })
          )
        ).status
      ).toBe(401)
      expect(test.received).toEqual([])
    }
  )

  it('keeps same-identity credential rotation and canonical URL spelling deliverable', async () => {
    const remote = await peer((input) => ({
      body: input.path.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
        : { code: 0, data: { message_id: 'om_sent' } }
    }))

    cleanup.push(remote.close)
    const initial = await setup(remote.url)

    const restarted = await setup(`${remote.url}/`, undefined, {
      appSecret: { env: 'ROTATED' }
    })

    expect(
      (await restarted.plugin.send(sendInput(initial.target))).status
    ).toBe('sent')
    expect(remote.requests).toHaveLength(1)
  })

  it('bounds event bodies and keeps canceled token refresh retryable', async () => {
    const remote = await peer(() => ({
      body: { code: 0, tenant_access_token: 'tenant-token', expire: 1 }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)

    const oversized = new Request('https://relay.example/channels/fs/events', {
      method: 'POST',
      headers: {
        'x-lark-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-lark-request-nonce': 'nonce-1'
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
      status: 'retryable',
      errorCode: 'tenant_token_transport_error'
    })
    expect(remote.requests).toEqual([])
  })

  it('authenticates raw signature, freshness and encrypted URL challenge', async () => {
    const test = await setup()
    expect((await test.handler(request(event, false, true))).status).toBe(401)
    expect(
      (await test.handler(request(event, false, false, '1000000000'))).status
    ).toBe(401)
    expect(
      await (
        await test.handler(
          request(
            {
              type: 'url_verification',
              token: 'verification-token',
              challenge: 'challenge-1'
            },
            true
          )
        )
      ).json()
    ).toEqual({ challenge: 'challenge-1' })
    expect(
      (
        await test.handler(
          request(
            {
              type: 'url_verification',
              token: 'wrong-token',
              challenge: 'challenge-1'
            },
            true
          )
        )
      ).status
    ).toBe(401)
    expect(test.received).toHaveLength(0)
  })

  it.each([false, true])(
    'normalizes signed event text/tenant/thread (encrypted=%s)',
    async (encrypted) => {
      const test = await setup()
      expect((await test.handler(request(event, encrypted))).status).toBe(200)
      expect(test.received[0]).toMatchObject({
        source: { channel: 'feishu', accountId: 'fs', eventId: 'event-42' },
        senderId: 'ou_user',
        text: 'hello',
        target,
        context: { tenantKey: 'tenant-1' }
      })
    }
  )

  it('rejects foreign app/tenant/token and corrupted signed ciphertext', async () => {
    const test = await setup()
    for (const header of [
      { ...event.header, tenant_key: 'tenant-2' },
      { ...event.header, app_id: 'cli_other' },
      { ...event.header, token: 'wrong-token' }
    ]) {
      expect((await test.handler(request({ ...event, header }))).status).toBe(
        401
      )
    }
    expect(
      (await test.handler(request({ encrypt: 'AAAAAAAAAAAAAAAAAAAAAA==' })))
        .status
    ).toBe(400)
    expect(test.received).toHaveLength(0)
  })

  it('diagnoses unsupported sticker/bot events and never ACKs failed ingest', async () => {
    const test = await setup()
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: {
              ...event.event,
              message: { ...event.event.message, message_type: 'sticker' }
            }
          })
        )
      ).status
    ).toBe(200)
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: {
              ...event.event,
              sender: { ...event.event.sender, sender_type: 'app' }
            }
          })
        )
      ).status
    ).toBe(200)
    expect(test.received).toHaveLength(0)

    const failing = await setup(undefined, async () => {
      throw new Error('db unavailable')
    })

    expect((await failing.handler(request(event))).status).toBe(503)
  })

  it.each([
    { status: 503, body: {}, expected: 'retryable' },
    { status: 200, body: {}, expected: 'retryable' },
    { status: 403, body: {}, expected: 'rejected' }
  ])(
    'does not freeze unsent text after token endpoint HTTP $status',
    async ({ status, body, expected }) => {
      let tokenCalls = 0

      const remote = await peer(() =>
        ++tokenCalls === 1
          ? {
              body: { code: 0, tenant_access_token: 'startup-token', expire: 1 }
            }
          : { status, body }
      )

      cleanup.push(remote.close)
      const test = await setup(remote.url)
      expect((await test.plugin.send(sendInput(test.target))).status).toBe(
        expected
      )
      expect(remote.requests.map((input) => input.path)).toEqual([
        '/open-apis/auth/v3/tenant_access_token/internal'
      ])
    }
  )

  it('refreshes expiring tenant tokens and uses native Markdown post reply wire', async () => {
    let tokens = 0

    const remote = await peer((input) =>
      input.path.includes('tenant_access_token')
        ? {
            body: {
              code: 0,
              tenant_access_token: `tenant-token-${++tokens}`,
              expire: 30
            }
          }
        : { body: { code: 0, data: { message_id: 'om_sent' } } }
    )

    cleanup.push(remote.close)
    const test = await setup(remote.url)
    expect(await test.plugin.send(sendInput(test.target))).toEqual({
      status: 'sent',
      receipt: { platformMessageId: 'om_sent' }
    })
    expect(remote.requests[0]).toMatchObject({
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: { app_id: 'cli_app', app_secret: 'app-secret' }
    })
    expect(remote.requests[1]).toMatchObject({
      path: '/open-apis/im/v1/messages/om_message/reply',
      headers: { authorization: 'Bearer tenant-token-2' },
      body: {
        msg_type: 'post',
        content:
          '{"zh_cn":{"content":[[{"tag":"md","text":"**hello** [link](https://example.com) @everyone <@U123>"}]]}}',
        reply_in_thread: true
      }
    })
    await test.plugin.send(sendInput(test.target))
    expect(tokens).toBe(3)
  })

  it('uses chat-id create path when there is no referenced source message', async () => {
    const remote = await peer((input) => ({
      body: input.path.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
        : { code: 0, data: { message_id: 'om_sent' } }
    }))

    cleanup.push(remote.close)
    const test = await setup(remote.url)
    const { replyToId: _reply, threadId: _thread, ...chatTarget } = test.target
    expect((await test.plugin.send(sendInput(chatTarget))).status).toBe('sent')
    expect(remote.requests[0]).toMatchObject({
      path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      body: {
        receive_id: 'oc_chat',
        msg_type: 'post',
        content:
          '{"zh_cn":{"content":[[{"tag":"md","text":"**hello** [link](https://example.com) @everyone <@U123>"}]]}}'
      }
    })
  })

  it.each([
    {
      status: 429,
      body: { code: 99_991_400 },
      expected: {
        status: 'retryable',
        errorCode: 'rate_limited',
        retryAfterMs: 2000
      }
    },
    {
      status: 200,
      body: { code: 230_001, msg: 'raw secret details' },
      expected: { status: 'rejected', errorCode: 'feishu_api_error' }
    },
    {
      status: 401,
      body: { code: 99_991_672 },
      expected: { status: 'rejected', errorCode: 'platform_http_error' }
    },
    {
      status: 503,
      body: { code: 99_991_663 },
      expected: { status: 'unknown', errorCode: 'platform_http_error' }
    },
    {
      status: 200,
      body: { code: 0 },
      expected: { status: 'unknown', errorCode: 'invalid_platform_response' }
    }
  ])(
    'maps message API errors without raw fields',
    async ({ status, body, expected }) => {
      const remote = await peer((input) =>
        input.path.includes('tenant_access_token')
          ? {
              body: {
                code: 0,
                tenant_access_token: 'tenant-token',
                expire: 7200
              }
            }
          : { status, headers: { 'retry-after': '2' }, body }
      )

      cleanup.push(remote.close)
      const test = await setup(remote.url)
      expect(await test.plugin.send(sendInput(test.target))).toEqual(expected)
      expect(remote.requests).toHaveLength(1)
    }
  )

  it('rejects literal credentials, insecure remote URL and foreign tenant targets', async () => {
    const plugin = createFeishuChannel(environment)
    expect(() =>
      plugin.validateConfig({ appId: 'cli_app', appSecret: 'raw' })
    ).toThrow()

    const config = {
      appId: 'cli_app',
      appSecret: { env: 'APPSECRET' },
      encryptKey: { env: 'ENCRYPT' },
      verificationToken: { env: 'VERIFY' },
      tenantKey: 'tenant-1'
    }

    expect(() =>
      plugin.validateConfig({ ...config, apiBaseUrl: 'http://remote.example' })
    ).toThrow()
    expect(plugin.validateConfig({ ...config, domain: 'lark' }).domain).toBe(
      'lark'
    )
    const test = await setup()
    expect(
      await test.plugin.send(
        sendInput({
          ...test.target,
          data: { ...test.target.data, tenantKey: 'tenant-2' }
        })
      )
    ).toEqual({ status: 'rejected', errorCode: 'invalid_target' })
  })
})

it('acknowledges persisted and duplicate native events with HTTP 200 while retaining storage retries', async () => {
  // Source: https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq
  // Feishu treats a callback without HTTP 200 as failed and redelivers its event_id.
  const remote = await peer(() => ({
    body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
  }))

  cleanup.push(remote.close)
  const { core, storage } = await storedChannel(cleanup, environment, account)
  expect(await storage.listInbound({ limit: 10 })).toEqual([])
  const accepted = await core.fetch(request(event))
  expect(await storage.listInbound({ limit: 10 })).toHaveLength(1)
  expect(accepted.status).toBe(200)
  expect((await core.fetch(request(event))).status).toBe(200)
  expect(await storage.listInbound({ limit: 10 })).toHaveLength(1)
  await storage.close()
  expect(
    (
      await core.fetch(
        request({
          ...event,
          header: { ...event.header, event_id: 'event-text-storage-failed' }
        })
      )
    ).status
  ).toBe(503)
})

it.each([400, 401])(
  'refreshes the rejected inbound resource token on native HTTP %s redelivery',
  async (status) => {
    // Source: https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-99991663-error
    // Native resource fields: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7, code-gen/projects/im.ts.
    let tokens = 0
    let resources = 0

    const remote = await peer((captured) => {
      if (captured.path.includes('tenant_access_token')) {
        return {
          body: {
            code: 0,
            tenant_access_token: `tenant-token-${++tokens}`,
            expire: 7200
          }
        }
      }
      if (++resources === 1) {
        return {
          status,
          body: {
            code: 99_991_663,
            msg: 'Invalid access token for authorization. Please make a request with token attached.'
          }
        }
      }
      return {
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"code":99991663,"note":"ordinary user file"}')
      }
    })

    cleanup.push(remote.close)
    const { core, storage } = await storedChannel(cleanup, environment, account)

    const resourceEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          message_type: 'file',
          content: '{"file_key":"file_rejected","file_name":"report.json"}'
        }
      }
    }

    expect((await core.fetch(request(resourceEvent))).status).toBe(503)
    expect(await storage.listInbound({ limit: 10 })).toEqual([])
    expect(remote.requests).toMatchObject([
      {
        path: '/open-apis/im/v1/messages/om_message/resources/file_rejected?type=file',
        headers: { authorization: 'Bearer tenant-token-1' }
      }
    ])
    expect((await core.fetch(request(resourceEvent))).status).toBe(200)
    expect(remote.requests).toMatchObject([
      {
        path: '/open-apis/im/v1/messages/om_message/resources/file_rejected?type=file',
        headers: { authorization: 'Bearer tenant-token-1' }
      },
      {
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        body: { app_id: 'cli_app', app_secret: 'app-secret' }
      },
      {
        path: '/open-apis/im/v1/messages/om_message/resources/file_rejected?type=file',
        headers: { authorization: 'Bearer tenant-token-2' }
      }
    ])
    await expectJsonResource(storage)
  }
)

it('preserves successful JSON resources that contain native error-code-looking data', async () => {
  const remote = await peer((captured) =>
    captured.path.includes('tenant_access_token')
      ? { body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } }
      : {
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"code":99991663,"note":"ordinary user file"}')
        }
  )

  cleanup.push(remote.close)
  const { core, storage } = await storedChannel(cleanup, environment, account)
  expect(
    (
      await core.fetch(
        request({
          ...event,
          event: {
            ...event.event,
            message: {
              ...event.event.message,
              message_type: 'file',
              content: '{"file_key":"file_json","file_name":"ordinary.json"}'
            }
          }
        })
      )
    ).status
  ).toBe(200)
  expect(remote.requests.map((captured) => captured.path)).toEqual([
    '/open-apis/im/v1/messages/om_message/resources/file_json?type=file'
  ])
  await expectJsonResource(storage)
})

async function expectJsonResource(
  storage: Awaited<ReturnType<typeof storedChannel>>['storage']
): Promise<void> {
  const records = await storage.listInbound({ limit: 10 })
  expect(records).toHaveLength(1)
  const reference = records[0]?.snapshot.attachments?.[0]
  const channelId = records[0]?.snapshot.channel.id
  if (!reference || !channelId) {
    throw new Error('missing_json_resource')
  }
  expect(reference.kind).toBe('file')
  expect(reference.mimeType).toBe('application/json')
  const media = await storage.media?.get(channelId, reference.id)
  expect(new TextDecoder().decode(media?.data)).toBe(
    '{"code":99991663,"note":"ordinary user file"}'
  )
}

it.each([
  { status: 401, body: {} },
  { status: 503, body: { code: 99_991_663 } }
])(
  'retains the cached resource token for unknown HTTP $status failures',
  async ({ status, body }) => {
    const remote = await peer((captured) =>
      captured.path.includes('tenant_access_token')
        ? {
            body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
          }
        : { status, body }
    )

    cleanup.push(remote.close)
    const { core, storage } = await storedChannel(cleanup, environment, account)

    const unknownEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          message_type: 'file',
          content: '{"file_key":"file_unknown","file_name":"report.json"}'
        }
      }
    }

    expect((await core.fetch(request(unknownEvent))).status).toBe(503)
    expect((await core.fetch(request(unknownEvent))).status).toBe(503)
    expect(await storage.listInbound({ limit: 10 })).toEqual([])
    expect(remote.requests).toMatchObject([
      {
        path: '/open-apis/im/v1/messages/om_message/resources/file_unknown?type=file',
        headers: { authorization: 'Bearer tenant-token' }
      },
      {
        path: '/open-apis/im/v1/messages/om_message/resources/file_unknown?type=file',
        headers: { authorization: 'Bearer tenant-token' }
      }
    ])
  }
)

it('resolves authenticated Feishu threads through their real root message while omitting visual reply quoting', async () => {
  const remote = await peer((input) => ({
    body: input.path.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'token', expire: 7200 }
      : { code: 0, data: { message_id: 'sent' } }
  }))

  cleanup.push(remote.close)
  const local = await setup(remote.url)

  const address = {
    id: 'channel',
    platform: 'feishu' as const,
    accountId: 'fs',
    chatId: 'oc_chat',
    threadId: 'omt_thread'
  }

  expect(await local.plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'address_unresolved'
  })
  expect(
    (
      await local.handler(
        request({
          ...event,
          event: {
            ...event.event,
            message: { ...event.event.message, root_id: 'om_root' }
          }
        })
      )
    ).status
  ).toBe(200)
  const learned = local.received[0]?.target
  const resolved = await local.plugin.resolveChannel?.(address, learned)
  expect(resolved).toMatchObject({
    status: 'available',
    target: { threadId: 'omt_thread', data: { threadAnchor: 'om_root' } }
  })
  if (resolved?.status !== 'available') {
    throw new Error('missing_thread_anchor')
  }
  expect(resolved.target.replyToId).toBe('om_message')
  expect(await local.plugin.send(sendInput(resolved.target))).toMatchObject({
    status: 'sent'
  })
  expect(remote.requests.at(-1)).toMatchObject({
    path: '/open-apis/im/v1/messages/om_root/reply',
    body: { reply_in_thread: true }
  })
  expect(
    await local.plugin.resolveChannel?.(
      { ...address, chatId: 'another_chat' },
      learned
    )
  ).toEqual({ status: 'unavailable', reason: 'address_unresolved' })
})

it('quotes three selected Feishu messages out of order while ordinary thread sends use the root', async () => {
  // Native reply endpoint and reply_in_thread:
  // https://open.feishu.cn/document/server-docs/im-v1/message/reply
  const remote = await peer((input) => ({
    body: input.path.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'token', expire: 7200 }
      : { code: 0, data: { message_id: 'sent' } }
  }))

  cleanup.push(remote.close)

  const { core, storage, agentHost } = await storedChannel(
    cleanup,
    environment,
    account
  )

  for (const number of [1, 2, 3]) {
    expect(
      (
        await core.fetch(
          request({
            ...event,
            header: { ...event.header, event_id: `event-${number}` },
            event: {
              ...event.event,
              message: {
                ...event.event.message,
                message_id: `om_message_${number}`,
                root_id: 'om_root'
              }
            }
          })
        )
      ).status
    ).toBe(200)
  }

  const principal = agentHost.forPrincipal({
    subject: 'first',
    endpointIds: ['first']
  })

  const requests = await storage.listInbound({ limit: 10 })
  const channel = requests[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  for (const number of [2, 1, 3]) {
    const selected = requests.find(
      (item) => item.snapshot.target.replyToId === `om_message_${number}`
    )

    if (!selected) {
      throw new Error('missing_request')
    }
    expect(
      await principal.sendMessage({
        channel,
        text: `answer ${number}`,
        idempotencyKey: `answer-${number}`,
        reply: { requestId: selected.snapshot.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await core.processDue()
  }
  expect(
    await principal.sendMessage({
      channel,
      text: 'ordinary',
      idempotencyKey: 'ordinary'
    })
  ).toMatchObject({ status: 'queued' })
  await core.processDue()
  expect(
    remote.requests
      .filter((item) => item.path.includes('/im/v1/messages'))
      .map((item) => item.path)
  ).toEqual([
    '/open-apis/im/v1/messages/om_message_2/reply',
    '/open-apis/im/v1/messages/om_message_1/reply',
    '/open-apis/im/v1/messages/om_message_3/reply',
    '/open-apis/im/v1/messages/om_root/reply'
  ])
})

it.each(
  [200, 400, 401].flatMap((status) =>
    ['message', 'upload'].map((operation) => ({ status, operation }))
  )
)(
  'refreshes a rejected tenant token and retries the persisted $operation after HTTP $status',
  async ({ status, operation }) => {
    // Source: https://open.feishu.cn/document/faq/trouble-shooting/how-to-fix-99991663-error
    // Code 99991663 is intercepted during tenant token authentication; obtain a new token and retry.
    let tokens = 0
    let messages = 0
    let uploads = 0

    const remote = await peer((captured) => {
      if (captured.path.includes('tenant_access_token')) {
        return {
          body: {
            code: 0,
            tenant_access_token: `tenant-token-${++tokens}`,
            expire: 7200
          }
        }
      }

      const rejected =
        captured.path === '/open-apis/im/v1/images'
          ? operation === 'upload' && ++uploads === 1
          : operation === 'message' && ++messages === 1

      if (rejected) {
        return {
          status,
          body: {
            code: 99_991_663,
            msg: 'Invalid access token for authorization. Please make a request with token attached.'
          }
        }
      }
      if (captured.path === '/open-apis/im/v1/images') {
        return { body: { code: 0, data: { image_key: 'img_uploaded' } } }
      }
      return { body: { code: 0, data: { message_id: 'om_recovered' } } }
    })

    cleanup.push(remote.close)

    const { core, storage, agentHost } = await storedChannel(
      cleanup,
      environment,
      account
    )

    expect((await core.fetch(request(event))).status).toBe(200)

    const principal = agentHost.forPrincipal({
      subject: 'first',
      endpointIds: ['first']
    })

    const channel = (await principal.status()).channels[0]?.channel.id
    if (!channel) {
      throw new Error('missing_learned_channel')
    }

    const queued = await principal.sendMessage({
      channel,
      text: operation === 'upload' ? '' : 'The answer',
      ...(operation === 'upload'
        ? {
            attachments: [
              {
                kind: 'image' as const,
                mimeType: 'image/png',
                fileName: 'answer.png',
                data: new Uint8Array([1, 2, 3, 4])
              }
            ]
          }
        : {}),
      idempotencyKey: 'recover-tenant-token'
    })

    expect(queued.status).toBe('queued')
    if (queued.status !== 'queued') {
      throw new Error('missing_queued_delivery')
    }
    await core.processDue()
    const pending = await storage.getOutbound(queued.deliveryId)
    expect(pending?.receipts).toEqual([])
    expect(pending?.currentChunk).toBe(0)
    expect(remote.requests).toMatchObject([
      {
        path:
          operation === 'upload'
            ? '/open-apis/im/v1/images'
            : '/open-apis/im/v1/messages/om_message/reply',
        headers: { authorization: 'Bearer tenant-token-1' }
      }
    ])
    expect(pending).toMatchObject({
      status: 'pending',
      attempts: 1,
      errorCode: 'feishu_token_invalid'
    })

    // Exercise the real core retry after its persisted due time with real SQLite.
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, (pending?.dueAt ?? 0) - Date.now()) + 10)
    })
    await core.processDue()
    expect(await storage.getOutbound(queued.deliveryId)).toMatchObject({
      status: 'sent',
      receipts: [{ platformMessageId: 'om_recovered' }]
    })
    expect(remote.requests.slice(1, 3)).toMatchObject([
      { path: '/open-apis/auth/v3/tenant_access_token/internal' },
      {
        path:
          operation === 'upload'
            ? '/open-apis/im/v1/images'
            : '/open-apis/im/v1/messages/om_message/reply',
        headers: { authorization: 'Bearer tenant-token-2' }
      }
    ])
    expect(remote.requests.at(-1)).toMatchObject({
      path: '/open-apis/im/v1/messages/om_message/reply',
      headers: { authorization: 'Bearer tenant-token-2' },
      body: {
        msg_type: operation === 'upload' ? 'image' : 'post',
        content:
          operation === 'upload'
            ? '{"image_key":"img_uploaded"}'
            : '{"zh_cn":{"content":[[{"tag":"md","text":"The answer"}]]}}',
        reply_in_thread: true
      }
    })
    expect(remote.requests).toHaveLength(operation === 'upload' ? 4 : 3)
  }
)

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

it('uploads an image key and sends ordered Markdown/image post rows to Feishu', async () => {
  const remote = await peer((input) => {
    if (input.path.includes('tenant_access_token')) {
      return {
        body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
      }
    }
    if (input.path === '/open-apis/im/v1/images') {
      return { body: { code: 0, data: { image_key: 'img_uploaded' } } }
    }
    return { body: { code: 0, data: { message_id: 'om_sent' } } }
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
  expect(remote.requests).toHaveLength(2)
  expect(remote.requests[0]).toMatchObject({
    path: '/open-apis/im/v1/images',
    headers: { authorization: 'Bearer tenant-token' }
  })
  expect(remote.requests[0]?.body).toContain('name="image_type"')
  expect(remote.requests[1]).toMatchObject({
    path: '/open-apis/im/v1/messages/om_message/reply',
    body: {
      msg_type: 'post',
      reply_in_thread: true,
      content:
        '{"zh_cn":{"content":[[{"tag":"md","text":"**before**"}],[{"tag":"img","image_key":"img_uploaded"}],[{"tag":"md","text":"after"}]]}}'
    }
  })
  const count = remote.requests.length
  expect(await local.plugin.send({ ...input, richMedia: [] })).toMatchObject({
    status: 'rejected',
    errorCode: 'invalid_rich_media'
  })
  expect(
    await local.plugin.send({
      ...input,
      chunk: {
        ...input.chunk,
        richText: [
          { type: 'text', text: 'a'.repeat(8001) },
          { type: 'image', media: richImage.reference, label: 'photo' }
        ]
      }
    })
  ).toMatchObject({ status: 'rejected', errorCode: 'rich_text_limit_exceeded' })
  expect(remote.requests).toHaveLength(count)
})

it('does not post a rich Feishu message without a successful uploaded image key', async () => {
  const remote = await peer((captured) => ({
    body: captured.path.includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
      : { code: 999, msg: 'upload unavailable' }
  }))

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
  ).toMatchObject({
    status: 'retryable',
    errorCode: 'media_upload_transport_error'
  })
  expect(remote.requests.map((captured) => captured.path)).toEqual([
    '/open-apis/im/v1/images'
  ])
})

it('accepts native Markdown post rows in authenticated inbound events', async () => {
  // Source: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
  // Channel/outbound/markdown/to-post.ts emits native md rows; normalize/converters/post.ts preserves their text.
  const local = await setup()

  const response = await local.handler(
    request({
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          message_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: 'Question',
              content: [[{ tag: 'md', text: '**Please** explain this.' }]]
            }
          })
        }
      }
    })
  )

  expect(response.status).toBe(200)
  expect(local.received).toHaveLength(1)
  expect(local.received[0]?.text).toBe('Question\n**Please** explain this.')
})

it.each([false, true])(
  'preserves labeled native post link destinations (localized=%s)',
  async (localized) => {
    // Source: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
    // Channel/normalize/converters/post.ts renders a elements from their text and href.
    const local = await setup()

    const post = {
      title: 'Question',
      content: [
        [
          { tag: 'text', text: 'Analyze ' },
          {
            tag: 'a',
            text: 'the report',
            href: 'https://example.com/report?version=2#summary'
          },
          { tag: 'text', text: ' and explain the findings.' }
        ]
      ]
    }

    const response = await local.handler(
      request({
        ...event,
        event: {
          ...event.event,
          message: {
            ...event.event.message,
            message_type: 'post',
            content: JSON.stringify(localized ? { zh_cn: post } : post)
          }
        }
      })
    )

    expect(response.status).toBe(200)
    expect(local.received).toHaveLength(1)
    expect(local.received[0]?.text).toBe(
      'Question\nAnalyze [the report](https://example.com/report?version=2#summary) and explain the findings.'
    )
  }
)

it.each([
  { message_type: 'text', content: { text: '@_user_1 asks @_user_10' } },
  {
    message_type: 'post',
    content: {
      content: [
        [
          { tag: 'at', user_id: '@_user_1', user_name: '' },
          { tag: 'text', text: ' asks ' },
          { tag: 'at', user_id: '@_user_10', user_name: '' }
        ]
      ]
    }
  }
])(
  'resolves native mention placeholders in $message_type messages',
  async ({ message_type, content }) => {
    // Source: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
    // Channel/normalize/context.ts RawMention and channel/normalize/mentions.ts resolveMentions.
    // Native empty post user_name: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
    const local = await setup()

    const response = await local.handler(
      request({
        ...event,
        event: {
          ...event.event,
          message: {
            ...event.event.message,
            message_type,
            content: JSON.stringify(content),
            mentions: [
              { key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } },
              { key: '@_user_10', name: 'Bob', id: { open_id: 'ou_bob' } }
            ]
          }
        }
      })
    )

    expect(response.status).toBe(200)
    expect(local.received[0]?.text).toBe('@Alice asks @Bob')
  }
)

it('preserves the native shortcode in emotion-only rich posts', async () => {
  // Source: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
  // Native emotion elements carry emoji_type, including SMILE, without a text field.
  const local = await setup()

  const response = await local.handler(
    request({
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          message_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [[{ tag: 'emotion', emoji_type: 'SMILE' }]]
          })
        }
      }
    })
  )

  expect(response.status).toBe(200)
  expect(local.received).toHaveLength(1)
  expect(local.received[0]?.text).toBe(':SMILE:')
})

it.each([
  { scenario: 'oversized', status: 200, acknowledgement: 200 },
  { scenario: 'unavailable', status: 503, acknowledgement: 503 }
])(
  'returns the native retry outcome for $scenario resources',
  async ({ status, acknowledgement }) => {
    // Source: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
    // Code-gen/projects/im.ts messageResource.get allows binary resources up to 100 MB.
    // Native retry ACK: https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
    const remote = await peer((captured) =>
      captured.path.includes('tenant_access_token')
        ? {
            body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
          }
        : {
            status,
            headers: { 'content-type': 'application/octet-stream' },
            body:
              status === 200
                ? new Uint8Array(26 * 1024 * 1024)
                : new Uint8Array()
          }
    )

    cleanup.push(remote.close)

    // Keep the configured-limit refusal contract independent of the default size.
    const { core, storage } = await storedChannel(
      cleanup,
      environment,
      account,
      {
        maxMediaBytes: 25 * 1024 * 1024
      }
    )

    const oversized = await core.fetch(
      request({
        ...event,
        event: {
          ...event.event,
          message: {
            ...event.event.message,
            message_type: 'file',
            content: '{"file_key":"file_large","file_name":"large.bin"}'
          }
        }
      })
    )

    expect(await storage.listInbound({ limit: 10 })).toEqual([])
    expect(remote.requests.map((captured) => captured.path)).toEqual([
      '/open-apis/im/v1/messages/om_message/resources/file_large?type=file'
    ])
    expect(oversized.status).toBe(acknowledgement)
    expect(
      (
        await core.fetch(
          request({
            ...event,
            header: { ...event.header, event_id: 'event-after-oversized' }
          })
        )
      ).status
    ).toBe(200)
    const records = await storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot.text).toBe('hello')
  }
)

it.each([
  { limit: 'too_many_attachments', worker: { maxAttachments: 1 } },
  { limit: 'media_total_too_large', worker: { maxTotalMediaBytes: 1 } }
])(
  'acknowledges the configured $limit policy without persisting an oversized post',
  async ({ worker }) => {
    // Native resource fields: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
    // Channel/normalize/converters/post.ts and code-gen/projects/im.ts messageResource.get.
    // ACK contract: https://open.feishu.cn/document/server-docs/event-subscription-guide/overview
    const remote = await peer((captured) =>
      captured.path.includes('tenant_access_token')
        ? {
            body: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 }
          }
        : {
            headers: { 'content-type': 'image/png' },
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
              'base64'
            )
          }
    )

    cleanup.push(remote.close)

    const { core, storage } = await storedChannel(
      cleanup,
      environment,
      account,
      worker
    )

    const limited = await core.fetch(
      request({
        ...event,
        event: {
          ...event.event,
          message: {
            ...event.event.message,
            message_type: 'post',
            content: JSON.stringify({
              content: [
                [{ tag: 'img', image_key: 'img_one' }],
                [{ tag: 'img', image_key: 'img_two' }]
              ]
            })
          }
        }
      })
    )

    expect(await storage.listInbound({ limit: 10 })).toEqual([])
    expect(remote.requests.map((captured) => captured.path).toSorted()).toEqual(
      [
        '/open-apis/im/v1/messages/om_message/resources/img_one?type=image',
        '/open-apis/im/v1/messages/om_message/resources/img_two?type=image'
      ]
    )
    expect(limited.status).toBe(200)
    expect(
      (
        await core.fetch(
          request({
            ...event,
            header: { ...event.header, event_id: 'event-after-post-limit' }
          })
        )
      ).status
    ).toBe(200)
    const records = await storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot.text).toBe('hello')
  }
)

it.each([
  {
    kind: 'image',
    encrypted: false,
    content: { image_key: 'img_native' },
    mime: 'image/png',
    resource: 'img_native',
    type: 'image'
  },
  {
    kind: 'file',
    encrypted: true,
    content: { file_key: 'file_native', file_name: 'notes.txt' },
    mime: 'text/plain',
    resource: 'file_native',
    type: 'file'
  }
])(
  'rejects denied $kind senders before native resource traffic and retains allowed storage failure retries',
  async ({ kind, encrypted, content, mime, resource, type }) => {
    // Native fixture: larksuite/node-sdk e34a66f0d20935ee77f94909d16d93292d58b6c7,
    // Channel/normalize/context.ts RawMessageEvent; code-gen/projects/im.ts messageResource.get.
    const remote = await peer((captured) =>
      captured.path.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tenant-token', expire: 1 } }
        : {
            headers: { 'content-type': mime },
            body: new Uint8Array([1, 2, 3, 4])
          }
    )

    cleanup.push(remote.close)
    const { core, storage } = await storedChannel(cleanup, environment, account)

    const mediaEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          message_type: kind,
          content: JSON.stringify(content)
        }
      }
    }

    const denied = {
      ...mediaEvent,
      event: {
        ...mediaEvent.event,
        sender: {
          ...mediaEvent.event.sender,
          sender_id: { open_id: 'OU_USER' }
        }
      }
    }

    expect((await core.fetch(request(denied, encrypted))).status).toBe(200)
    expect(remote.requests).toEqual([])
    expect(await storage.listInbound({ limit: 10 })).toEqual([])
    expect((await core.fetch(request(mediaEvent, encrypted))).status).toBe(200)
    expect(remote.requests.map((captured) => captured.path)).toEqual([
      '/open-apis/auth/v3/tenant_access_token/internal',
      `/open-apis/im/v1/messages/om_message/resources/${resource}?type=${type}`
    ])
    const records = await storage.listInbound({ limit: 10 })
    expect(records).toHaveLength(1)
    expect(records[0]?.snapshot.senderId).toBe('ou_user')
    expect(records[0]?.snapshot.attachments).toHaveLength(1)
    await storage.close()
    expect(
      (
        await core.fetch(
          request(
            {
              ...mediaEvent,
              header: { ...mediaEvent.header, event_id: 'event-storage-failed' }
            },
            encrypted
          )
        )
      ).status
    ).toBe(503)
  }
)
