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

test('HTTP replies finish the selected original callback after three requests arrive', async () => {
  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  const streams = new Map<number, string>()
  for (const number of [1, 2, 3]) {
    const response = await callbackReply(
      await host.runtime.fetch(
        callbackRequest(callbackMessage(`message-${number}`))
      )
    )

    streams.set(number, response.stream.id)
  }
  const accepted = await records(host.storage)
  const principal = host.principal()
  for (const number of [2, 1, 3]) {
    const selected = accepted.find(
      (item) => item.snapshot.source.eventId === `message-${number}`
    )

    const stream = streams.get(number)
    if (!selected || !stream) {
      throw new Error('missing_callback')
    }

    const queued = await principal.sendMessage({
      channel: selected.snapshot.channel.id,
      text: `answer ${number}`,
      idempotencyKey: `reply-${number}`,
      reply: { requestId: selected.snapshot.requestId, kind: 'final' }
    })

    expect(queued).toMatchObject({ status: 'queued' })
    if (queued.status !== 'queued') {
      throw new Error('missing_delivery')
    }
    await host.runtime.processDue()
    expect(
      await callbackReply(await host.runtime.fetch(streamRefresh(stream)))
    ).toMatchObject({ stream: { finish: true, content: `answer ${number}` } })
    // Core keeps the channel ordered until the platform polls the completed
    // Response and the pending delivery is acknowledged on its saved due time.
    await expect
      .poll(
        async () => {
          await host.runtime.processDue()
          return (await host.storage.getOutbound(queued.deliveryId))?.status
        },
        { timeout: 5000 }
      )
      .toBe('sent')
  }
})

// The SDK owns callback crypto; signature/freshness checks still protect Core.
// The old test also enforced a local empty-suffix restriction, which the SDK's
// Optional receiveId intentionally does not impose. This uses independent wire
// Encryption and real SQLite, with no production testing interface.
// Published @wecom/aibot-node-sdk 1.0.7 dist/index.esm.js: WecomCrypto.decrypt
// Only checks the receiveId suffix when a nonempty receiveId was configured.
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
  for (const options of [{ token: 'forged' }, { timestamp: '1' }]) {
    const response = await host.runtime.fetch(
      callbackRequest(callbackMessage(), options)
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  }
  expect(await records(host.storage)).toEqual([])
  expect(
    (
      await host.runtime.fetch(
        callbackRequest(
          { ...callbackMessage(), aibotid: 'other' },
          { receiver: 'sdk-optional-receiver' }
        )
      )
    ).status
  ).toBe(503)
  expect(await records(host.storage)).toEqual([])
  expect(
    (
      await host.runtime.fetch(
        callbackRequest(callbackMessage(), {
          receiver: 'sdk-optional-receiver'
        })
      )
    ).status
  ).toBe(200)
  expect(
    (await records(host.storage)).map(
      (record) => record.snapshot.source.eventId
    )
  ).toEqual(['callback-1'])
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

  const response = await host.runtime.fetch(callbackRequest(callbackMessage()))
  // Native encrypted HTTP replies: WecomTeam/wecom-openclaw-plugin at
  // 3b1cbe3e664352821758d99ae5907f5620fce26e,
  // `src/webhook/handler.ts` sendEncryptedReply uses text/plain JSON.
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  const pendingReply = await callbackReply(response)

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
      channel: inbound.channel.id,
      text: 'x'.repeat(20_481)
    })
  ).rejects.toThrow('reply_exceeds_channel_limit')
  expect(await host.storage.listOutbound({ limit: 10 })).toEqual([])
  await host
    .principal()
    .sendMessage({ channel: inbound.channel.id, text: 'short answer' })
  await host.runtime.processDue()
  expect(
    await callbackReply(
      await host.runtime.fetch(streamRefresh(pendingReply.stream.id))
    )
  ).toMatchObject({ stream: { finish: true, content: 'short answer' } })
  expect(remote.requests).toEqual([])
})

test.each(['https://evil.example/steal', 'not-a-url'])(
  'callback ignores unused response URL %s while keeping authenticated passive replies and bot identity checks',
  async (responseUrl) => {
    const remote = await peer(() => ({ body: { errcode: 0 } }))
    routePlatform('https://qyapi.weixin.qq.com', remote.http)

    const host = await assemble(createWeComChannel(), callbackConfig, [
      { chatId: 'user', senderId: 'user' }
    ])

    await host.start()

    const pending = await callbackReply(
      await host.runtime.fetch(
        callbackRequest({
          ...callbackMessage(),
          response_url: responseUrl
        })
      )
    )

    const inbound = (await records(host.storage))[0]?.snapshot

    if (!inbound) {
      throw new Error('missing_callback')
    }
    await host.principal().sendMessage({
      channel: inbound.channel.id,
      text: 'final answer'
    })
    await host.runtime.processDue()
    expect(
      await callbackReply(
        await host.runtime.fetch(streamRefresh(pending.stream.id))
      )
    ).toMatchObject({ stream: { finish: true, content: 'final answer' } })
    expect(
      (
        await host.runtime.fetch(
          callbackRequest({ ...callbackMessage('foreign'), aibotid: 'foreign' })
        )
      ).status
    ).toBe(503)
    expect(await records(host.storage)).toHaveLength(1)
    expect(remote.requests).toEqual([])
  }
)

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

test('callback refuses changed conversation targets, conflicting callback retries and expired passive windows', async () => {
  const remote = await peer(() => ({ body: { errcode: 0 } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)
  const plugin = createWeComChannel()

  const host = await assemble(plugin, callbackConfig, [
    { chatId: 'user', senderId: 'user' },
    { chatId: 'other', senderId: 'other' }
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
  expect(
    (
      await host.runtime.fetch(
        callbackRequest({
          ...callbackMessage(),
          from: { userid: 'other' }
        })
      )
    ).status
  ).toBe(503)
  expect(await records(host.storage)).toHaveLength(1)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(Date.now() + 600_001)
    expect(await plugin.send(input)).toMatchObject({
      status: 'rejected',
      errorCode: 'callback_stream_expired'
    })
  } finally {
    vi.useRealTimers()
  }
  expect(remote.requests).toEqual([])
})

test('callback decrypts inbound images and returns a final image through signed encrypted polling', async () => {
  // Complete 1x1 PNG, including a valid zlib stream and chunk CRCs (PNG 3).
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
    'base64'
  )

  const cipher = createCipheriv(
    'aes-256-cbc',
    callbackKey,
    callbackKey.subarray(0, 16)
  )

  cipher.setAutoPadding(false)

  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(28, 28)])),
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
    size: 68
  })
  if (!inbound || !attachment) {
    throw new Error('missing durable image')
  }
  await host.principal().sendMessage({
    channel: inbound.channel.id,
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
          base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
          md5: 'edb2aa47631c67a43709d4ccd2501e33'
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
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
      'base64'
    )
  }))

  await original.principal().sendMessage({
    channel: inbound.channel.id,
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
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
        md5: 'edb2aa47631c67a43709d4ccd2501e33'
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
  expect(resolved.target.replyToId).toBe('callback-1')
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

test('recovers an accepted keyed channel send after its authentic callback capability is consumed and expired', async () => {
  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  const principal = host.principal()
  const before = await principal.status()
  expect(before.channels).toMatchObject([
    { send: { status: 'unavailable', reason: 'address_unresolved' } }
  ])
  const channel = before.channels[0]?.channel.id
  if (!channel) {
    throw new Error('Missing callback channel')
  }

  const pending = await callbackReply(
    await host.runtime.fetch(callbackRequest(callbackMessage()))
  )

  const input = {
    channel,
    idempotencyKey: 'callback-send-intent',
    text: 'final answer'
  }

  const receipt = await principal.sendMessage(input)
  expect(receipt).toMatchObject({ status: 'queued', replay: false })
  await host.runtime.processDue()
  expect(
    (
      await callbackReply(
        await host.runtime.fetch(streamRefresh(pending.stream.id))
      )
    ).stream
  ).toMatchObject({ finish: true, content: 'final answer' })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000)
  try {
    expect((await principal.status()).channels).toMatchObject([
      { send: { status: 'unavailable' } }
    ])
    expect(await principal.sendMessage(input)).toEqual({
      ...receipt,
      replay: true
    })
    await expect(
      principal.sendMessage({ ...input, idempotencyKey: 'new-send' })
    ).rejects.toMatchObject({ code: 'channel_unavailable' })
    expect(await host.storage.listOutbound({ limit: 10 })).toHaveLength(1)
  } finally {
    clock.mockRestore()
  }
})
