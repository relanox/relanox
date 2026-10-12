import { installPeerNetwork, routePlatform } from './network.js'
import { beforeEach, expect, test, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { createWeComChannel } from '../src/index.js'
import {
  assemble,
  peer,
  records,
  sendInput,
  temporaryDatabase
} from './test-support.js'
import {
  callbackConfig,
  callbackKey,
  callbackMessage,
  callbackRequest,
  callbackReply,
  streamRefresh
} from './callback-peer.js'

installPeerNetwork()
beforeEach(() => {
  vi.stubEnv('CALLBACK_TOKEN', 'callback-token')
  vi.stubEnv('CALLBACK_KEY', callbackKey.toString('base64').replace(/=+$/u, ''))
})

test('callback verifies URL challenges and rejects forged or stale encrypted requests before ingestion', async () => {
  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()

  const echo = await host.runtime.fetch(
    callbackRequest('challenge', { echo: true })
  )

  expect(echo.status).toBe(200)
  expect(await echo.text()).toBe('challenge')
  for (const options of [
    { token: 'forged' },
    { timestamp: '1' },
    { receiver: 'unexpected-receiver' }
  ]) {
    const response = await host.runtime.fetch(
      callbackRequest(callbackMessage(), options)
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  }
  expect(await records(host.storage)).toEqual([])
})

test('callback persists a deduplicated message and private reply destination across plugin restart', async () => {
  const remote = await peer(() => ({ body: { errcode: 0, errmsg: 'ok' } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)
  const filename = await temporaryDatabase()
  const original = createWeComChannel()

  const host = await assemble(
    original,
    callbackConfig,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await host.start()

  const pendingReply = await callbackReply(
    await host.runtime.fetch(callbackRequest(callbackMessage()))
  )

  expect(pendingReply.stream).toMatchObject({ finish: false, content: '' })
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      (await host.runtime.fetch(callbackRequest(callbackMessage()))).status
    ).toBe(200)
  }
  const accepted = await records(host.storage)
  expect(accepted).toHaveLength(1)
  expect(accepted[0]?.snapshot.text).toBe('callback question')
  expect(JSON.stringify(accepted)).not.toContain('private-reply-key')
  const target = accepted[0]?.snapshot.target
  if (!target) {
    throw new Error('missing accepted target')
  }
  await original.stop?.()
  const restored = createWeComChannel()

  const recovered = await assemble(
    restored,
    callbackConfig,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await recovered.start()

  const result = await restored.send({
    ...sendInput('wecom', 'user', target.data),
    target
  })

  expect(result.status).toBe('pending')
  expect(
    (
      await recovered.runtime.fetch(
        streamRefresh(pendingReply.stream.id, 'other-user')
      )
    ).status
  ).toBe(503)

  const final = await callbackReply(
    await recovered.runtime.fetch(streamRefresh(pendingReply.stream.id))
  )

  expect(final).toMatchObject({
    msgtype: 'stream',
    stream: { finish: true, content: 'hello_*世界' }
  })
  expect(remote.requests).toEqual([])
  expect(remote.sockets).toHaveLength(0)
  expect(
    (
      await restored.send({
        ...sendInput('wecom', 'user', target.data),
        target
      })
    ).status
  ).toBe('sent')
  expect(
    await callbackReply(
      await recovered.runtime.fetch(streamRefresh(pendingReply.stream.id))
    )
  ).toEqual(final)
  expect(remote.requests).toEqual([])
})

test('callback rejects an oversized reply atomically before consuming its one reply opportunity', async () => {
  const remote = await peer(() => ({ body: { errcode: 0 } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)

  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()

  const pendingReply = await callbackReply(
    await host.runtime.fetch(callbackRequest(callbackMessage()))
  )

  const inbound = (await records(host.storage))[0]?.snapshot
  if (!inbound) {
    throw new Error('missing callback')
  }
  await expect(
    host.principal().sendMessage({
      replyTo: inbound.requestId,
      text: 'x'.repeat(20_481)
    })
  ).rejects.toThrow('reply_exceeds_channel_limit')
  expect(await host.storage.listOutbound({ limit: 10 })).toEqual([])
  await host
    .principal()
    .sendMessage({ replyTo: inbound.requestId, text: 'short answer' })
  await host.runtime.processDue()
  expect(
    await callbackReply(
      await host.runtime.fetch(streamRefresh(pendingReply.stream.id))
    )
  ).toMatchObject({ stream: { finish: true, content: 'short answer' } })
  expect(remote.requests).toEqual([])
})

test('callback rejects reply URL redirection and foreign bot identities without durable messages', async () => {
  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  for (const message of [
    { ...callbackMessage(), response_url: 'https://evil.example/steal' },
    { ...callbackMessage(), aibotid: 'foreign' }
  ]) {
    await host.runtime.fetch(callbackRequest(message))
  }
  expect(await records(host.storage)).toEqual([])
})

test('callback reserves one final reply across competing deliveries without using the active response URL', async () => {
  const remote = await peer(() => ({ disconnect: true }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)
  const plugin = createWeComChannel()

  const host = await assemble(plugin, callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  await host.runtime.fetch(callbackRequest(callbackMessage()))
  const target = (await records(host.storage))[0]?.snapshot.target
  if (!target) {
    throw new Error('missing callback')
  }
  const input = { ...sendInput('wecom', 'user', target.data), target }
  expect((await plugin.send(input)).status).toBe('pending')
  expect(
    await plugin.send({ ...input, deliveryId: 'different-delivery' })
  ).toMatchObject({ status: 'rejected', errorCode: 'callback_reply_used' })
  expect((await plugin.send(input)).status).toBe('pending')
  expect(remote.requests).toEqual([])
})

test('callback refuses changed conversation targets and expired reply credentials', async () => {
  const remote = await peer(() => ({ body: { errcode: 0 } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)
  const plugin = createWeComChannel()

  const host = await assemble(plugin, callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  await host.runtime.fetch(callbackRequest(callbackMessage()))
  const target = (await records(host.storage))[0]?.snapshot.target
  if (!target) {
    throw new Error('missing callback')
  }
  const input = { ...sendInput('wecom', 'user', target.data), target }
  expect(
    await plugin.send({ ...input, target: { ...target, chatId: 'other' } })
  ).toMatchObject({ status: 'rejected', errorCode: 'target_identity_changed' })
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 3_600_001)
    expect(await plugin.send(input)).toMatchObject({
      status: 'rejected',
      errorCode: 'response_url_expired'
    })
  } finally {
    vi.useRealTimers()
  }
  expect(remote.requests).toEqual([])
})

test('callback decrypts inbound images and returns a final image through signed encrypted polling', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

  const cipher = createCipheriv(
    'aes-256-cbc',
    callbackKey,
    callbackKey.subarray(0, 16)
  )

  cipher.setAutoPadding(false)

  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(21, 21)])),
    cipher.final()
  ])

  const remote = await peer((request) =>
    request.method === 'GET'
      ? {
          body: encrypted,
          headers: { 'content-type': 'application/octet-stream' }
        }
      : { body: { errcode: 0 } }
  )

  routePlatform('https://qyapi.weixin.qq.com', remote.http)

  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()

  const response = await host.runtime.fetch(
    callbackRequest({
      ...callbackMessage('image'),
      msgtype: 'image',
      text: undefined,
      image: { url: `${remote.http}/image` }
    })
  )

  expect(response.status).toBe(200)
  const pendingReply = await callbackReply(response)
  const inbound = (await records(host.storage))[0]?.snapshot
  const attachment = inbound?.attachments?.[0]
  expect(attachment).toMatchObject({
    kind: 'image',
    mimeType: 'image/png',
    size: 11
  })
  if (!inbound || !attachment) {
    throw new Error('missing durable image')
  }
  await host.principal().sendMessage({
    replyTo: inbound.requestId,
    text: '',
    attachments: [attachment.id]
  })
  await host.runtime.processDue()

  const final = await callbackReply(
    await host.runtime.fetch(streamRefresh(pendingReply.stream.id))
  )

  expect(final.stream).toMatchObject({
    finish: true,
    content: '',
    msg_item: [
      {
        msgtype: 'image',
        image: {
          base64: 'iVBORw0KGgoBAgM=',
          md5: '8ca92d7f177036b4a00594a4aa98468e'
        }
      }
    ]
  })
  expect(
    remote.requests.filter((request) => request.method === 'POST')
  ).toEqual([])
})

test('callback recovers a final Markdown caption with ten images and repeats the same final after a lost poll', async () => {
  const filename = await temporaryDatabase()
  const first = createWeComChannel()

  const original = await assemble(
    first,
    callbackConfig,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await original.start()

  const pending = await callbackReply(
    await original.runtime.fetch(
      callbackRequest({ ...callbackMessage(), response_url: undefined })
    )
  )

  const inbound = (await records(original.storage))[0]?.snapshot
  if (!inbound) {
    throw new Error('missing inbound')
  }

  const attachments = Array.from({ length: 10 }, (_, index) => ({
    kind: 'image' as const,
    mimeType: 'image/png',
    fileName: `${index}.png`,
    data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  }))

  await original.principal().sendMessage({
    replyTo: inbound.requestId,
    text: '**caption** [link](https://example.com)',
    attachments
  })
  await original.runtime.processDue()
  expect((await original.storage.listOutbound({ limit: 10 }))[0]).toMatchObject(
    { status: 'pending', currentChunk: 10, attempts: 0 }
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    for (let check = 0; check < 9; check++) {
      vi.setSystemTime(Date.now() + 2000)
      await original.runtime.processDue()
    }
    expect(
      (await original.storage.listOutbound({ limit: 10 }))[0]
    ).toMatchObject({ status: 'pending', attempts: 0 })
  } finally {
    vi.useRealTimers()
  }
  await first.stop?.()
  await original.storage.close()
  const second = createWeComChannel()

  const restored = await assemble(
    second,
    callbackConfig,
    [{ chatId: 'user', senderId: 'user' }],
    filename
  )

  await restored.start()
  // Drop the first response exactly as a disconnected external poll could do.
  await restored.runtime.fetch(streamRefresh(pending.stream.id))

  const final = await callbackReply(
    await restored.runtime.fetch(streamRefresh(pending.stream.id))
  )

  expect(final.stream).toMatchObject({
    finish: true,
    content: '**caption** [link](https://example.com)'
  })
  expect(final.stream.msg_item).toEqual(
    Array.from({ length: 10 }, () => ({
      msgtype: 'image',
      image: {
        base64: 'iVBORw0KGgoBAgM=',
        md5: '8ca92d7f177036b4a00594a4aa98468e'
      }
    }))
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 30_000)
    await restored.runtime.processDue()
    expect(
      (await restored.storage.listOutbound({ limit: 10 }))[0]?.status
    ).toBe('sent')
  } finally {
    vi.useRealTimers()
  }
  expect(
    await callbackReply(
      await restored.runtime.fetch(streamRefresh(pending.stream.id))
    )
  ).toEqual(final)
})

test('callback preserves an existing one-use active reply credential when a pre-upgrade event is retried', async () => {
  const remote = await peer(() => ({ body: { errcode: 0 } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)
  const plugin = createWeComChannel()

  const host = await assemble(plugin, callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  const expiresAt = Date.now() + 3_600_000
  await host.storage.compareAndSetState(
    { pluginId: 'channel-wecom', ownerId: 'bot' },
    {
      key: 'callback:robot:callback-1',
      expectedVersion: null,
      expiresAt,
      value: {
        responseUrl:
          'https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=private-reply-key',
        expiresAt,
        chatId: 'user',
        eventId: 'callback-1',
        botId: 'robot'
      }
    }
  )
  const response = await host.runtime.fetch(callbackRequest(callbackMessage()))
  expect(await response.text()).toBe('')
  const target = (await records(host.storage))[0]?.snapshot.target
  if (!target) {
    throw new Error('missing callback')
  }
  const input = { ...sendInput('wecom', 'user', target.data), target }
  expect((await plugin.send(input)).status).toBe('sent')
  expect((await plugin.send(input)).status).toBe('rejected')
  expect(remote.requests.map((request) => request.body)).toEqual([
    { msgtype: 'markdown', markdown: { content: 'hello_*世界' } }
  ])
})

test('WeCom HTTP resolves only a real unexpired unused authenticated callback capability', async () => {
  const plugin = createWeComChannel()

  const host = await assemble(plugin, callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()

  const address = {
    id: 'channel',
    platform: 'wecom' as const,
    accountId: 'bot',
    chatId: 'user'
  }

  expect(await plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'address_unresolved'
  })
  expect(
    (
      await host.runtime.fetch(
        callbackRequest(callbackMessage(), { token: 'forged' })
      )
    ).status
  ).toBeGreaterThanOrEqual(400)
  expect(await plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'address_unresolved'
  })

  const pending = await callbackReply(
    await host.runtime.fetch(callbackRequest(callbackMessage()))
  )

  const learned = (await records(host.storage))[0]?.snapshot.target
  const resolved = await plugin.resolveChannel?.(address, learned)
  if (resolved?.status !== 'available') {
    throw new Error('missing_callback_capability')
  }
  expect(resolved.target.replyToId).toBeUndefined()
  expect(
    await plugin.send({
      ...sendInput('wecom', 'user', resolved.target.data),
      target: resolved.target
    })
  ).toMatchObject({ status: 'pending' })
  expect(await plugin.resolveChannel?.(address, learned)).toEqual({
    status: 'unavailable',
    reason: 'callback_reply_used'
  })

  const final = await callbackReply(
    await host.runtime.fetch(streamRefresh(pending.stream.id))
  )

  expect(final.stream).toMatchObject({ finish: true, content: 'hello_*世界' })
})
