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
  callbackRequest
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

  expect(result.status).toBe('sent')
  expect(remote.requests).toHaveLength(1)
  expect(remote.requests[0]).toMatchObject({
    method: 'POST',
    path: '/cgi-bin/aibot/response?response_code=private-reply-key',
    body: {
      msgtype: 'markdown',
      markdown: { content: 'hello\\_\\*世界' }
    }
  })
  expect(remote.sockets).toHaveLength(0)
  expect(
    (
      await restored.send({
        ...sendInput('wecom', 'user', target.data),
        target
      })
    ).status
  ).toBe('rejected')
  expect(remote.requests).toHaveLength(1)
})

test('callback rejects an oversized reply atomically before consuming its one reply opportunity', async () => {
  const remote = await peer(() => ({ body: { errcode: 0 } }))
  routePlatform('https://qyapi.weixin.qq.com', remote.http)

  const host = await assemble(createWeComChannel(), callbackConfig, [
    { chatId: 'user', senderId: 'user' }
  ])

  await host.start()
  await host.runtime.fetch(callbackRequest(callbackMessage()))
  const inbound = (await records(host.storage))[0]?.snapshot
  if (!inbound) {
    throw new Error('missing callback')
  }
  await expect(
    host
      .principal()
      .sendMessage({ replyTo: inbound.requestId, text: 'x'.repeat(2049) })
  ).rejects.toThrow('reply_exceeds_channel_limit')
  expect(await host.storage.listOutbound({ limit: 10 })).toEqual([])
  await host
    .principal()
    .sendMessage({ replyTo: inbound.requestId, text: 'short answer' })
  await host.runtime.processDue()
  expect(remote.requests).toHaveLength(1)
  expect(remote.requests[0]?.body).toEqual({
    msgtype: 'markdown',
    markdown: { content: 'short answer' }
  })
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

test('callback reserves one reply across concurrent sends and preserves uncertainty after a dropped HTTP response', async () => {
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
  const results = await Promise.all([plugin.send(input), plugin.send(input)])
  expect(results.map((result) => result.status).toSorted()).toEqual([
    'rejected',
    'unknown'
  ])
  expect(remote.requests).toHaveLength(1)
  expect((await plugin.send(input)).status).toBe('rejected')
  expect(remote.requests).toHaveLength(1)
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

test('callback decrypts images with the configured AES key and rejects unsupported outbound media', async () => {
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
  expect(
    (
      await host.runtime.fetch(
        callbackRequest({
          ...callbackMessage('image'),
          msgtype: 'image',
          text: undefined,
          image: { url: `${remote.http}/image` }
        })
      )
    ).status
  ).toBe(200)
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
  await expect(
    host.principal().sendMessage({
      replyTo: inbound.requestId,
      text: '',
      attachments: [attachment.id]
    })
  ).rejects.toThrow('media_not_supported')
  expect(
    remote.requests.filter((request) => request.method === 'POST')
  ).toEqual([])
})
