import { createHmac, generateKeyPair } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import type { ChannelAddress } from '@relanox/sdk'
import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { resolutionFixture, resolverInput } from './resolution-fixture.js'
import { trafficJson } from './media-peer.js'

installPeerNetwork()

const destinations = [
  {
    platform: 'telegram',
    chatId: '-123',
    threadId: '42',
    path: '/bot123:secret/sendMessage',
    body: { chat_id: '-123', message_thread_id: 42 }
  },
  {
    platform: 'discord',
    chatId: '321',
    threadId: '654',
    path: '/channels/654/messages',
    body: { content: 'hello' }
  },
  {
    platform: 'slack',
    chatId: 'C1',
    threadId: '1700000000.001',
    path: '/chat.postMessage',
    body: { channel: 'C1', thread_ts: '1700000000.001' }
  },
  {
    platform: 'matrix',
    chatId: '!room:example',
    threadId: '$root',
    path: '/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/delivery%3A0',
    body: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }
  },
  {
    platform: 'mattermost',
    chatId: 'a'.repeat(26),
    threadId: 'b'.repeat(26),
    path: '/api/v4/posts',
    body: { channel_id: 'a'.repeat(26), root_id: 'b'.repeat(26) }
  },
  {
    platform: 'line',
    chatId: `U${'a'.repeat(32)}`,
    path: '/v2/bot/message/push',
    body: { to: `U${'a'.repeat(32)}` }
  },
  {
    platform: 'signal',
    chatId: 'direct:+15550002',
    path: '/api/v1/rpc',
    body: { params: { recipient: ['+15550002'] } }
  },
  {
    platform: 'signal',
    chatId: 'group:group-id',
    path: '/api/v1/rpc',
    body: { params: { groupId: 'group-id' } }
  },
  {
    platform: 'feishu',
    chatId: 'oc_chat',
    path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
    body: { receive_id: 'oc_chat' }
  },
  {
    platform: 'dingtalk',
    chatId: 'user',
    path: '/v1.0/robot/oToMessages/batchSend',
    body: { userIds: ['user'] }
  },
  {
    platform: 'dingtalk',
    chatId: 'group',
    path: '/v1.0/robot/groupMessages/send',
    body: { openConversationId: 'group' }
  },
  {
    platform: 'qq',
    chatId: 'user',
    path: '/v2/users/user/messages',
    body: { msg_type: 2 }
  },
  {
    platform: 'qq',
    chatId: 'group',
    path: '/v2/groups/group/messages',
    body: { msg_type: 2 }
  }
] as const

it.each(destinations)(
  '$platform resolves and sends a bound native destination before any inbound message: $chatId',
  async (destination) => {
    const { plugin, remote, received } = await resolutionFixture(
      destination.platform
    )

    const address = {
      id: 'bound-channel',
      platform: plugin.channel,
      accountId: 'account',
      chatId: destination.chatId,
      ...('threadId' in destination ? { threadId: destination.threadId } : {})
    }

    const resolution = await plugin.resolveChannel?.(address)
    expect(resolution?.status).toBe('available')
    if (resolution?.status !== 'available') {
      throw new Error('missing_destination')
    }
    expect(resolution.target).toMatchObject({
      channel: destination.platform,
      accountId: 'account',
      chatId: destination.chatId
    })
    expect(resolution.target.replyToId).toBeUndefined()
    if ('threadId' in destination) {
      expect(resolution.target.threadId).toBe(destination.threadId)
    }
    expect(await plugin.send(resolverInput(resolution.target))).toMatchObject({
      status: 'sent'
    })

    const effect = remote.traffic.find(
      (traffic) => traffic.path === destination.path
    )

    expect(effect).toBeDefined()
    if (!effect) {
      throw new Error('missing_platform_effect')
    }
    const body = trafficJson(effect)
    expect(body).toMatchObject(destination.body)
    expect(body).not.toHaveProperty('message_reference')
    expect(body).not.toHaveProperty('reply_parameters')
    expect(body).not.toHaveProperty('msg_id')
    if (destination.platform === 'matrix') {
      expect(body).not.toHaveProperty('m.relates_to.m.in_reply_to')
    }
    expect(received).toEqual([])
    expect(
      await plugin.resolveChannel?.({
        ...address,
        accountId: 'another-account'
      })
    ).toEqual({ status: 'unavailable', reason: 'invalid_address' })
  }
)

it('Google Chat resolves configured native space/thread and rejects a thread from a different space', async () => {
  const { plugin, remote } = await resolutionFixture('googlechat')

  const address = {
    id: 'channel',
    platform: plugin.channel,
    accountId: 'account',
    chatId: 'spaces/one',
    threadId: 'spaces/one/threads/root'
  }

  expect(await plugin.resolveChannel?.(address)).toEqual({
    status: 'available',
    target: {
      channel: 'googlechat',
      accountId: 'account',
      chatId: 'spaces/one',
      threadId: 'spaces/one/threads/root',
      data: {
        space: 'spaces/one',
        thread: 'spaces/one/threads/root',
        scope: {
          clientEmail: 'bot@example.com',
          apiBase: 'https://chat.googleapis.com/'
        }
      }
    }
  })
  expect(
    await plugin.resolveChannel?.({
      ...address,
      threadId: 'spaces/other/threads/root'
    })
  ).toEqual({ status: 'unavailable', reason: 'invalid_address' })
  const keys = await promisify(generateKeyPair)('rsa', { modulusLength: 2048 })
  vi.stubEnv(
    'GOOGLE_SERVICE',
    JSON.stringify({
      type: 'service_account',
      client_email: 'bot@example.com',
      private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    })
  )
  const resolved = await plugin.resolveChannel?.(address)
  if (resolved?.status !== 'available') {
    throw new Error('missing_destination')
  }
  expect(await plugin.send(resolverInput(resolved.target))).toMatchObject({
    status: 'sent'
  })

  const effect = remote.traffic.find(
    (traffic) =>
      traffic.path ===
      '/v1/spaces/one/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL'
  )

  if (!effect) {
    throw new Error('missing_platform_effect')
  }
  expect(trafficJson(effect)).toMatchObject({
    thread: { name: 'spaces/one/threads/root' }
  })
})

it.each(['wecom', 'qq', 'dingtalk'])(
  '%s requires an explicit recipient type or authenticated learned address',
  async (platform) => {
    const { plugin } = await resolutionFixture(platform, { recipientTypes: {} })

    const address = {
      id: 'channel',
      platform: plugin.channel,
      accountId: 'account',
      chatId: 'user'
    }

    expect(await plugin.resolveChannel?.(address)).toEqual({
      status: 'unavailable',
      reason: 'address_unresolved'
    })
    expect(
      await plugin.resolveChannel?.({ ...address, chatId: 'constructor' })
    ).toEqual({ status: 'unavailable', reason: 'address_unresolved' })
  }
)

it('WeCom websocket derives configured single/group type without manufacturing an incoming message', async () => {
  const { plugin, received } = await resolutionFixture('wecom')
  for (const [chatId, chattype] of [
    ['user', 'single'],
    ['group', 'group']
  ]) {
    expect(
      await plugin.resolveChannel?.({
        id: 'channel',
        platform: 'wecom',
        accountId: 'account',
        chatId: chatId ?? ''
      })
    ).toMatchObject({
      status: 'available',
      target: { chatId, data: { chattype } }
    })
  }
  expect(received).toEqual([])
})

it('IRC resolves native channels and dm nicknames and rejects a nested recipient that redirects the bound chat', async () => {
  const { plugin } = await resolutionFixture('irc')

  const address: ChannelAddress = {
    id: 'channel',
    platform: 'irc',
    accountId: 'account',
    chatId: '#room'
  }

  const resolved = await plugin.resolveChannel?.(address)
  expect(resolved).toMatchObject({
    status: 'available',
    target: { chatId: '#room', data: { recipient: '#room' } }
  })
  expect(
    await plugin.resolveChannel?.({ ...address, chatId: 'dm:Alice' })
  ).toMatchObject({
    status: 'available',
    target: { data: { recipient: 'Alice' } }
  })
  expect(
    await plugin.resolveChannel?.({ ...address, chatId: 'dm:Alice\r\nJOIN' })
  ).toMatchObject({ status: 'unavailable' })
  if (resolved?.status !== 'available') {
    throw new Error('missing_destination')
  }
  expect(
    await plugin.send(
      resolverInput({
        ...resolved.target,
        data: {
          recipient: '#other',
          server: 'irc.example',
          port: 6697,
          tls: true
        }
      })
    )
  ).toEqual({ status: 'rejected', errorCode: 'target_mismatch' })
})

it('Signal rejects nested group/direct recipients that redirect the bound chat', async () => {
  const { plugin, origin, remote } = await resolutionFixture('signal')
  expect(
    await plugin.send(
      resolverInput({
        channel: 'signal',
        accountId: 'account',
        chatId: 'direct:+15550002',
        data: {
          kind: 'direct',
          recipient: '+15559999',
          account: '+15550001',
          serviceUrl: origin
        }
      })
    )
  ).toEqual({ status: 'rejected', errorCode: 'target_mismatch' })
  expect(remote.traffic).toEqual([])
})

it('WhatsApp status and send use the persisted authenticated customer window', async () => {
  const { plugin, host, handlers } = await resolutionFixture('whatsapp')

  const address: ChannelAddress = {
    id: 'channel',
    platform: 'whatsapp',
    accountId: 'account',
    chatId: '15550002'
  }

  expect(await plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'customer_window_expired'
  })

  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'business',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone' },
              messages: [
                {
                  id: 'message',
                  from: '15550002',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'hello' }
                }
              ]
            }
          }
        ]
      }
    ]
  })

  const handler = handlers.get('/webhook')
  if (!handler) {
    throw new Error('missing_webhook')
  }
  expect(
    (
      await handler(
        new Request('https://relay.example/webhook', {
          method: 'POST',
          body,
          headers: {
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
          }
        })
      )
    ).status
  ).toBe(200)
  const resolved = await plugin.resolveChannel?.(address)
  expect(resolved?.status).toBe('available')
  if (resolved?.status !== 'available') {
    throw new Error('missing_customer_window')
  }
  expect(resolved.target.replyToId).toBeUndefined()
  expect(await plugin.send(resolverInput(resolved.target))).toMatchObject({
    status: 'sent'
  })
  const entry = (await host.state.list({ prefix: 'window:', limit: 10 }))[0]
  if (!entry) {
    throw new Error('missing_customer_window')
  }
  await host.state.compareAndSet({
    key: entry.key,
    expectedVersion: entry.version,
    value: Date.now() - 1
  })
  expect(await plugin.send(resolverInput(resolved.target))).toEqual({
    status: 'rejected',
    errorCode: 'customer_window_expired'
  })
})

it('Teams and Feishu thread status stay unresolved before authenticated conversation context exists', async () => {
  const teams = await resolutionFixture('msteams')
  expect(
    await teams.plugin.resolveChannel?.({
      id: 'channel',
      platform: 'msteams',
      accountId: 'account',
      chatId: 'conversation'
    })
  ).toEqual({ status: 'unavailable', reason: 'address_unresolved' })
  const feishu = await resolutionFixture('feishu')
  expect(
    await feishu.plugin.resolveChannel?.({
      id: 'channel',
      platform: 'feishu',
      accountId: 'account',
      chatId: 'oc_chat',
      threadId: 'omt_thread'
    })
  ).toEqual({ status: 'unavailable', reason: 'address_unresolved' })
})
