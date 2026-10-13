import {
  routePlatform,
  installPeerNetwork
} from '../../channel-wecom/tests/network.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Json,
  SendInput,
  Storage,
  InboundSnapshot,
  OutboundRecord,
  ScopedAgentHost
} from '@relanox/sdk'
import { createWhatsAppChannel } from '../src/index.js'
import { harness, peer, rewriteSavedOrigin } from './harness.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

const config = (): Json => ({
  phoneNumberId: 'phone',
  businessAccountId: 'business-1',
  appSecret: { env: 'WA_SECRET' },
  verifyToken: { env: 'WA_VERIFY' },
  accessToken: { env: 'WA_TOKEN' }
})

function webhook(
  timestamp = Math.floor(Date.now() / 1000),
  phone = 'phone',
  eventId = 'wamid.1',
  type: 'text' | 'reaction' = 'text'
): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'business-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phone },
              messages: [
                {
                  id: eventId,
                  from: 'customer',
                  timestamp: String(timestamp),
                  type,
                  ...(type === 'text'
                    ? { text: { body: 'hello' } }
                    : {
                        reaction: {
                          message_id: 'previous-message',
                          emoji: '\uD83D\uDC4D'
                        }
                      })
                }
              ]
            }
          }
        ]
      }
    ]
  })
}

function incoming(body: string, signature?: string): Request {
  const expected = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  return new Request('http://local/channels/business/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature ?? expected },
    body
  })
}

async function setup(filename = ':memory:'): Promise<{
  core: CoreRuntime
  storage: Storage
  dispatches: string[]
  principal(this: void): ScopedAgentHost
  sendReply(
    this: void,
    text?: string
  ): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }>
  close(this: void): Promise<void>
  remote: Awaited<ReturnType<typeof peer>>
  plugin: ReturnType<typeof createWhatsAppChannel>
}> {
  vi.stubEnv('WA_SECRET', 'secret')
  vi.stubEnv('WA_VERIFY', 'verify')
  vi.stubEnv('WA_TOKEN', 'token')
  const remote = await peer()
  cleanup.push(remote.close)
  remote.respond(200, {
    messaging_product: 'whatsapp',
    messages: [{ id: 'wamid.sent' }]
  })
  const plugin = createWhatsAppChannel()

  const local = await harness(
    plugin,
    config(),
    'customer',
    'customer',
    undefined,
    filename
  )

  cleanup.push(local.close)
  return { remote, plugin, ...local }
}

describe('native WhatsApp Cloud', () => {
  // Meta's account_update ACCOUNT_DELETED example has no messages metadata:
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
  // Fields share the configured endpoint when subscribed in the App Dashboard:
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
  it('acknowledges account updates without losing relevant messages in the same envelope', async () => {
    const local = await setup()

    const update = {
      field: 'account_update',
      value: { event: 'ACCOUNT_DELETED' }
    }

    const envelope = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'business-1', time: 1_743_451_903, changes: [update] }]
    }

    expect(
      (await local.core.fetch(incoming(JSON.stringify(envelope)))).status
    ).toBe(200)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])

    const messageEnvelope = JSON.parse(webhook()) as {
      entry: { changes: unknown[] }[]
    }

    messageEnvelope.entry[0]?.changes.unshift(update)
    expect(
      (await local.core.fetch(incoming(JSON.stringify(messageEnvelope)))).status
    ).toBe(200)
    const accepted = await local.storage.listInbound({ limit: 10 })
    expect(accepted.map((record) => record.snapshot.text)).toEqual(['hello'])
    expect((await local.sendReply()).delivery?.status).toBe('sent')
  })

  // Cloud messages identify WABA in entry.id and the business phone in metadata:
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
  // Hermes Cloud (not Baileys) independently skips siblings in _dispatch_payload:
  // NousResearch/hermes-agent@09e2ffcab79322cdd9037660fe87004bbd8fd18f gateway/platforms/whatsapp_cloud.py
  it.each(['business', 'phone'] as const)(
    'ignores a sibling %s without blocking the configured account',
    async (identity) => {
      const local = await setup()

      const sibling = {
        id: identity === 'business' ? 'other-business' : 'business-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                phone_number_id: identity === 'phone' ? 'other-phone' : 'phone'
              },
              messages: [
                {
                  id: 'wamid.foreign',
                  from: 'customer',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'foreign' }
                }
              ]
            }
          }
        ]
      }

      const envelope = { object: 'whatsapp_business_account', entry: [sibling] }
      expect(
        (await local.core.fetch(incoming(JSON.stringify(envelope)))).status
      ).toBe(200)
      expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
      expect((await local.principal().status()).channels).toMatchObject([
        { send: { status: 'unavailable', reason: 'customer_window_expired' } }
      ])
      const relevant = JSON.parse(webhook()) as { entry: unknown[] }
      relevant.entry.unshift(sibling)
      expect(
        (await local.core.fetch(incoming(JSON.stringify(relevant)))).status
      ).toBe(200)
      const accepted = await local.storage.listInbound({ limit: 10 })
      expect(accepted.map((record) => record.snapshot.text)).toEqual(['hello'])
      expect((await local.sendReply()).delivery?.status).toBe('sent')
      expect(local.dispatches).toEqual(['hello'])
    }
  )

  it('still rejects malformed messages notifications rather than treating them as unrelated fields', async () => {
    const local = await setup()

    const malformed = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'business-1',
          changes: [{ field: 'messages', value: { event: 'ACCOUNT_DELETED' } }]
        }
      ]
    })

    expect((await local.core.fetch(incoming(malformed))).status).toBe(400)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
  })

  it('converts Markdown to WhatsApp styles and preserves explicit link targets', async () => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))

    const completed = await local.sendReply(
      '😀 **bold _both_** _ital_ ~~gone~~ `x*y` [site](https://example.com)'
    )

    expect(completed.delivery?.status).toBe('sent')
    expect(
      JSON.parse(local.remote.traffic[0]?.body ?? 'null') as unknown
    ).toMatchObject({
      type: 'text',
      text: {
        body: '😀 *bold* *_both_* _ital_ ~gone~ ```x*y``` site (https://example.com/)',
        preview_url: false
      }
    })
  })

  it('budgets generated code delimiters before sending split WhatsApp replies', async () => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))

    const completed = await local.sendReply(
      `\`\`\`ts\n${'界😀'.repeat(1500)}\n\`\`\``
    )

    expect(completed.delivery?.status).toBe('sent')

    const sent = local.remote.traffic.map(
      (item) => (JSON.parse(item.body) as { text: { body: string } }).text.body
    )

    expect(sent.length).toBeGreaterThan(1)
    for (const text of sent) {
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(text.startsWith('```') && text.endsWith('```')).toBe(true)
    }
    expect(sent.map((text) => text.slice(3, -3)).join('')).toBe(
      '界😀'.repeat(1500)
    )
  })

  it.each(['business', 'server', 'rotation'] as const)(
    'preserves pending reply identity across restart: %s',
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), 'relanox-whatsapp-'))
      cleanup.push(async () => {
        await rm(directory, { recursive: true })
      })
      const filename = join(directory, 'state.db')
      const local = await setup(filename)
      expect((await local.core.fetch(incoming(webhook()))).status).toBe(200)
      const channel = (await local.principal().status()).channels[0]?.channel.id
      if (!channel) {
        throw new Error('Missing native channel')
      }

      const queued = await local
        .principal()
        .sendMessage({ channel, idempotencyKey: 'saved-send', text: 'answer' })

      if (queued.status !== 'queued') {
        throw new Error('Missing queued native send')
      }
      await local.close()
      cleanup.pop()
      if (change === 'server') {
        rewriteSavedOrigin(filename)
      }
      const replacement = await peer()
      cleanup.push(replacement.close)
      replacement.respond(200, {
        messaging_product: 'whatsapp',
        messages: [{ id: 'wamid.other' }]
      })
      const plugin = createWhatsAppChannel()

      routePlatform('https://graph.facebook.com', local.remote.base)

      const next = plugin.validateConfig(config())

      if (change === 'business') {
        next.businessAccountId = 'business-2'
      }
      vi.stubEnv('WA_TOKEN', 'rotated-token')

      const restarted = await harness(
        plugin,
        next,
        'customer',
        'customer',
        undefined,
        filename
      )

      cleanup.push(restarted.close)
      await restarted.core.processDue()
      const completed = await restarted.storage.getOutbound(queued.deliveryId)
      expect(completed?.status).toBe(
        change === 'rotation' ? 'sent' : 'rejected'
      )
      expect(replacement.traffic).toHaveLength(0)
      expect(local.remote.traffic).toHaveLength(change === 'rotation' ? 1 : 0)
      if (change === 'rotation') {
        expect(local.remote.traffic[0]?.path).toBe('/v25.0/phone/messages')
        expect(local.remote.traffic[0]?.headers.authorization).toBe(
          'Bearer rotated-token'
        )
      }
    }
  )

  it('does not share customer windows across replacement phone identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relanox-whatsapp-window-'))
    cleanup.push(async () => {
      await rm(directory, { recursive: true })
    })
    const filename = join(directory, 'state.db')
    const local = await setup(filename)
    expect(
      (
        await local.core.fetch(
          incoming(webhook(undefined, 'phone', 'wamid.1', 'reaction'))
        )
      ).status
    ).toBe(200)
    await local.close()
    cleanup.pop()
    const plugin = createWhatsAppChannel()
    const next = plugin.validateConfig(config())
    next.phoneNumberId = 'replacement-phone'

    const restarted = await harness(
      plugin,
      next,
      'customer',
      'customer',
      undefined,
      filename
    )

    cleanup.push(restarted.close)
    expect(
      (
        await restarted.core.fetch(
          incoming(
            webhook(
              Math.floor(Date.now() / 1000) - 86_401,
              'replacement-phone',
              'wamid.old'
            )
          )
        )
      ).status
    ).toBe(200)
    expect((await restarted.principal().status()).channels).toMatchObject([
      { send: { status: 'unavailable', reason: 'customer_window_expired' } }
    ])
    await expect(restarted.sendReply()).rejects.toMatchObject({
      code: 'channel_unavailable'
    })
    expect(await restarted.storage.listOutbound({ limit: 10 })).toEqual([])
    expect(local.remote.traffic).toHaveLength(0)

    const request = (await restarted.storage.listInbound({ limit: 10 }))[0]
      ?.snapshot

    if (!request) {
      throw new Error('Missing accepted customer input')
    }
    expect(
      await plugin.send({
        deliveryId: 'guard-check',
        channelId: request.channel.id,
        target: {
          ...request.target,
          data: {
            phoneNumberId: 'replacement-phone',
            businessAccountId: 'business-1',
            apiBase: 'https://graph.facebook.com',
            customer: 'customer',
            windowUntil: Date.now() + 10_000
          }
        },
        chunk: {
          text: 'must not send',
          state: null,
          idempotencyKey: 'guard-check:0'
        },
        chunkIndex: 0,
        signal: new AbortController().signal
      })
    ).toEqual({ status: 'rejected', errorCode: 'customer_window_expired' })
    expect(local.remote.traffic).toHaveLength(0)
  })

  it('verifies challenge and exact HMAC, deduplicates and independently sends Graph text', async () => {
    const local = await setup()

    const challenge = await local.core.fetch(
      new Request(
        'http://local/channels/business/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345'
      )
    )

    expect(challenge.status).toBe(200)
    expect(await challenge.text()).toBe('12345')
    expect(
      (
        await local.core.fetch(
          new Request(
            'http://local/channels/business/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345'
          )
        )
      ).status
    ).toBe(403)
    expect(
      (await local.core.fetch(incoming(webhook(), 'sha256=bad'))).status
    ).toBe(401)
    expect((await local.core.fetch(incoming('{'))).status).toBe(400)
    expect(
      (await local.core.fetch(incoming(webhook(undefined, 'other-phone'))))
        .status
    ).toBe(200)
    const body = `${webhook()}\n`
    expect((await local.core.fetch(incoming(body))).status).toBe(200)
    expect((await local.core.fetch(incoming(body))).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)
    const completed = await local.sendReply()
    expect(completed.delivery?.status).toBe('sent')
    expect(local.dispatches).toEqual(['hello'])
    const sent = local.remote.traffic[0]
    expect(sent?.path).toBe('/v25.0/phone/messages')
    expect(sent?.headers.authorization).toBe('Bearer token')
    expect(JSON.parse(sent?.body ?? 'null') as unknown).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: 'customer',
      type: 'text',
      text: { body: 'answer', preview_url: false }
    })
    expect(completed.delivery?.receipts).toEqual([
      { platformMessageId: 'wamid.sent' }
    ])
  })

  it('rejects expired customer text and refreshes the durable window on newer non-text customer activity', async () => {
    const local = await setup()
    expect(
      (
        await local.core.fetch(
          incoming(webhook(Math.floor(Date.now() / 1000) - 86_401))
        )
      ).status
    ).toBe(200)
    await expect(local.sendReply()).rejects.toMatchObject({
      code: 'channel_unavailable'
    })
    expect(await local.storage.listOutbound({ limit: 10 })).toEqual([])

    const request = (await local.storage.listInbound({ limit: 10 }))[0]
      ?.snapshot

    if (!request) {
      throw new Error('Missing accepted input')
    }

    const send: SendInput = {
      deliveryId: 'expired-window-check',
      channelId: request.channel.id,
      target: request.target,
      chunk: { text: 'answer', state: null, idempotencyKey: 'expired:0' },
      chunkIndex: 0,
      signal: new AbortController().signal
    }

    expect(await local.plugin.send(send)).toEqual({
      status: 'rejected',
      errorCode: 'customer_window_expired'
    })
    expect(local.remote.traffic).toHaveLength(0)
    expect(
      (
        await local.core.fetch(
          incoming(webhook(undefined, 'phone', 'wamid.2', 'reaction'))
        )
      ).status
    ).toBe(200)
    expect((await local.principal().status()).channels).toMatchObject([
      { send: { status: 'available' } }
    ])
    expect((await local.sendReply()).delivery?.status).toBe('sent')
    expect(local.remote.traffic).toHaveLength(1)
  })

  it.each([
    [429, 'pending'],
    [403, 'rejected'],
    [503, 'unknown']
  ] as const)('maps provider HTTP %s to %s', async (status, expected) => {
    const local = await setup()
    await local.core.fetch(incoming(webhook()))
    local.remote.respond(status, {}, { 'retry-after': '2' })
    expect((await local.sendReply()).delivery?.status).toBe(expected)
    expect(local.remote.traffic).toHaveLength(1)
  })

  it('requires SecretRefs and rejects hosted endpoint overrides', () => {
    const plugin = createWhatsAppChannel()
    expect(() =>
      plugin.validateConfig({
        phoneNumberId: 'phone',
        businessAccountId: 'business-1',
        appSecret: 'secret',
        verifyToken: 'verify',
        accessToken: 'token'
      })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        phoneNumberId: 'phone',
        businessAccountId: 'business-1',
        appSecret: { env: 'SECRET' },
        verifyToken: { env: 'VERIFY' },
        accessToken: { env: 'TOKEN' },
        apiBase: 'http://127.0.0.1:1234'
      })
    ).toThrow()
  })
})
