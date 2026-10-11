import type { ServerResponse } from 'node:http'
import type { SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  body,
  harness,
  httpPeer,
  json,
  observations,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createSignalChannel } from '../src/index.js'

function config(base: string): {
  serviceUrl: string
  account: string
  selfUuid: string
  authorization: { env: string }
  allowInsecureLocalhost: boolean
} {
  return {
    serviceUrl: base,
    account: '+10000000001',
    selfUuid: 'bot-uuid',
    authorization: { env: 'SIGNAL_PROXY_AUTH' },
    allowInsecureLocalhost: true
  }
}

function envelope(
  sender: string,
  text: string,
  groupId?: string,
  account = '+10000000001'
): {
  account: string
  envelope: {
    source: string
    sourceUuid: string
    timestamp: number
    dataMessage: {
      groupInfo?: { groupId: string }
      timestamp: number
      message: string
    }
  }
} {
  return {
    account,
    envelope: {
      source: sender,
      sourceUuid: sender,
      timestamp: 1_800_000_000_000,
      dataMessage: {
        timestamp: 1_800_000_000_000,
        message: text,
        ...(groupId ? { groupInfo: { groupId } } : {})
      }
    }
  }
}

function frame(response: ServerResponse, value: unknown, id: string): void {
  const encoded = JSON.stringify(value)
  const separator = encoded.indexOf(',')
  const wire = `id: ${id}\r\nevent: receive\r\ndata: ${encoded.slice(0, separator + 1)}\r\ndata: ${encoded.slice(separator + 1)}\r\n\r\n`
  const bytes = Buffer.from(wire)
  const middle = Math.floor(bytes.length / 2)
  response.write(bytes.subarray(0, middle))
  response.write(bytes.subarray(middle))
}

function sendInput(base: string): SendInput {
  return {
    deliveryId: 'delivery',
    requestId: 'request',
    target: {
      channel: 'signal',
      accountId: 'bot',
      chatId: 'direct:alice',
      data: {
        kind: 'direct',
        recipient: 'alice',
        serviceUrl: base,
        account: '+10000000001'
      }
    },
    chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
    chunkIndex: 0,
    signal: new AbortController().signal
  }
}

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  method: z.literal('send'),
  params: z.object({
    account: z.string(),
    message: z.string(),
    textStyle: z.array(z.string()).optional(),
    recipient: z.array(z.string()).optional(),
    groupId: z.string().optional()
  })
})

it('sends Markdown as UTF-16 Signal styles with explicit links and literal code', async () => {
  const rpcs: z.infer<typeof rpcRequestSchema>[] = []

  const peer = await httpPeer(async (request, response) => {
    const rpc = rpcRequestSchema.parse(await body(request))
    rpcs.push(rpc)
    json(response, { jsonrpc: '2.0', id: rpc.id, result: { timestamp: 123 } })
  })

  const plugin = createSignalChannel({ SIGNAL_PROXY_AUTH: 'Bearer credential' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'direct:alice' }],
    ['alice'],
    `${peer.base}/dispatch`
  )
  const input = sendInput(peer.base)
  expect(
    (
      await plugin.send({
        ...input,
        chunk: {
          ...input.chunk,
          text: '😀 **bold** _ital_ ~~gone~~ `x*y` [site](https://example.com)'
        }
      })
    ).status
  ).toBe('sent')
  expect(rpcs[0]?.params).toEqual({
    account: '+10000000001',
    recipient: ['alice'],
    message: '😀 bold ital gone x*y site (https://example.com/)',
    textStyle: [
      '3:4:BOLD',
      '8:4:ITALIC',
      '13:4:STRIKETHROUGH',
      '18:3:MONOSPACE'
    ]
  })
})

it('restarts native monospace ranges in each UTF-8-bounded code chunk', async () => {
  const rpcs: z.infer<typeof rpcRequestSchema>[] = []

  const peer = await httpPeer(async (request, response) => {
    const rpc = rpcRequestSchema.parse(await body(request))
    rpcs.push(rpc)
    json(response, { jsonrpc: '2.0', id: rpc.id, result: { timestamp: 123 } })
  })

  const plugin = createSignalChannel({ SIGNAL_PROXY_AUTH: 'Bearer credential' })
  await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'direct:alice' }],
    ['alice'],
    `${peer.base}/dispatch`
  )
  const input = sendInput(peer.base)

  const parts =
    plugin.splitText?.(
      `\`\`\`ts\n${'界😀'.repeat(3000)}\n\`\`\``,
      input.target
    ) ?? []

  expect(parts.length).toBeGreaterThan(1)
  for (const [index, text] of parts.entries()) {
    expect(
      (
        await plugin.send({
          ...input,
          chunkIndex: index,
          chunk: { ...input.chunk, text }
        })
      ).status
    ).toBe('sent')
  }
  expect(rpcs.map((rpc) => rpc.params.message).join('')).toBe(
    '界😀'.repeat(3000)
  )
  for (const rpc of rpcs) {
    expect(Buffer.byteLength(rpc.params.message, 'utf8')).toBeLessThanOrEqual(
      16_000
    )
    expect(rpc.params.textStyle).toEqual([
      `0:${rpc.params.message.length}:MONOSPACE`
    ])
  }
})

it.each([
  ['SUCCESS', 'sent'],
  ['NETWORK_FAILURE', 'unknown'],
  ['UNREGISTERED_FAILURE', 'unknown'],
  ['IDENTITY_FAILURE', 'unknown'],
  ['RATE_LIMIT_FAILURE', 'unknown'],
  ['INVALID_PRE_KEY_FAILURE', 'unknown']
] as const)(
  'persists group recipient %s as %s without replaying partial sends',
  async (type, status) => {
    let sends = 0

    const peer = await httpPeer(async (request, response) => {
      if (request.url?.startsWith('/api/v1/events')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        frame(
          response,
          envelope('alice-uuid', 'group question', 'GROUP_BASE64='),
          'group-event'
        )
        return
      }
      if (request.url === '/api/v1/rpc') {
        const rpc = rpcRequestSchema.parse(await body(request))
        sends += 1
        json(response, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            timestamp: 1_800_000_000_999,
            results: [
              {
                recipientAddress: { uuid: 'alice-uuid' },
                groupId: 'GROUP_BASE64=',
                type: 'SUCCESS'
              },
              {
                recipientAddress: { uuid: 'bob-uuid' },
                groupId: 'GROUP_BASE64=',
                type
              }
            ]
          }
        })
        return
      }
      json(response, {})
    })

    const plugin = createSignalChannel({
      SIGNAL_PROXY_AUTH: 'Bearer credential'
    })

    const fixture = await harness(
      plugin,
      config(peer.base),
      [{ chatId: 'group:GROUP_BASE64=' }],
      ['alice-uuid'],
      `${peer.base}/dispatch`
    )

    await plugin.start?.(new AbortController().signal)
    await waitFor(
      async () =>
        (await fixture.storage.listInbound({ limit: 10 })).length === 1
    )
    await plugin.stop?.()
    await fixture.runtime.processDue()

    const pending = (await fixture.storage.listInbound({ limit: 10 }))[0]

    if (!pending) {
      throw new Error('Missing group request')
    }
    const completed = await fixture.sendReply(pending.snapshot.requestId)
    await fixture.runtime.processDue()
    expect(
      (await fixture.storage.getOutbound(completed.deliveryId))?.status
    ).toBe(status)
    await fixture.runtime.processDue()
    expect(sends).toBe(1)
  }
)

it('ingests SSE envelopes and independently sends direct and group replies through the real core', async () => {
  const streams: {
    account: string | null
    authorization: string | undefined
  }[] = []

  const rpcs: z.infer<typeof rpcRequestSchema>[] = []
  const dispatches: unknown[] = []

  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://peer')
    if (url.pathname === '/api/v1/events') {
      streams.push({
        account: url.searchParams.get('account'),
        authorization: request.headers.authorization
      })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': keepalive\n\n')
      frame(response, envelope('alice-uuid', 'direct 中文😀'), 'daemon-1')
      frame(response, envelope('alice-uuid', 'direct 中文😀'), 'daemon-2')
      frame(
        response,
        envelope('alice-uuid', 'group', 'GROUP_BASE64='),
        'daemon-3'
      )
      frame(response, envelope('bot-uuid', 'self'), 'daemon-4')
      frame(response, envelope('mallory-uuid', 'forbidden'), 'daemon-5')
      frame(
        response,
        envelope('alice-uuid', 'other account', undefined, '+19999999999'),
        'daemon-6'
      )
      return
    }
    const data = await body(request)
    if (url.pathname === '/api/v1/rpc') {
      const rpc = rpcRequestSchema.parse(data)
      rpcs.push(rpc)
      json(response, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { timestamp: 1_800_000_000_999 }
      })
      return
    }
    dispatches.push(data)
    json(response, {})
  })

  const plugin = createSignalChannel({
    SIGNAL_PROXY_AUTH: 'Bearer proxy-secret'
  })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'direct:alice-uuid' }, { chatId: 'group:GROUP_BASE64=' }],
    ['alice-uuid'],
    `${peer.base}/dispatch`
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await fixture.storage.getState(
          { pluginId: 'channel-signal', ownerId: 'bot' },
          'events'
        )
      )?.value === 'daemon-6'
  )
  await plugin.stop?.()
  const requests = await fixture.storage.listInbound({ limit: 10 })
  expect(requests).toHaveLength(2)
  expect(streams).toEqual([
    { account: '+10000000001', authorization: 'Bearer proxy-secret' }
  ])
  expect(requests.map((request) => request.snapshot.text).toSorted()).toEqual([
    'direct 中文😀',
    'group'
  ])
  expect(JSON.stringify(requests)).not.toContain('proxy-secret')

  const direct = requests.find(
    (request) => request.snapshot.text === 'direct 中文😀'
  )

  const group = requests.find((request) => request.snapshot.text === 'group')
  if (!direct || !group) {
    throw new Error('Missing direct/group requests')
  }
  expect(direct.snapshot.target.data).toEqual({
    kind: 'direct',
    recipient: 'alice-uuid',
    serviceUrl: peer.base,
    account: '+10000000001'
  })
  expect(group.snapshot.target.data).toEqual({
    kind: 'group',
    groupId: 'GROUP_BASE64=',
    serviceUrl: peer.base,
    account: '+10000000001'
  })
  await fixture.runtime.processDue()
  expect(dispatches).toHaveLength(2)
  for (const request of await fixture.storage.listInbound({ limit: 10 })) {
    const result = await fixture.sendReply(request.snapshot.requestId)
    await fixture.runtime.processDue()
    expect((await fixture.storage.getOutbound(result.deliveryId))?.status).toBe(
      'sent'
    )
  }
  expect(rpcs.map((rpc) => rpc.params)).toEqual(
    expect.arrayContaining([
      {
        account: '+10000000001',
        message: 'delayed answer',
        groupId: 'GROUP_BASE64='
      },
      {
        account: '+10000000001',
        message: 'delayed answer',
        recipient: ['alice-uuid']
      }
    ])
  )
  expect(rpcs).toHaveLength(2)
  expect(rpcs.every((rpc) => rpc.id.endsWith(':0'))).toBe(true)
  expect(plugin.capabilities.idempotentSend).toBe(false)
})

it('reloads committed Last-Event-ID and deduplicates by sender, timestamp and conversation after restart', async () => {
  const lastIds: (string | undefined)[] = []

  const peer = await httpPeer((request, response) => {
    if (!request.url?.startsWith('/api/v1/events')) {
      json(response, {})
      return
    }
    const lastId = request.headers['last-event-id']
    lastIds.push(typeof lastId === 'string' ? lastId : undefined)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    frame(response, envelope('alice-uuid', 'first'), 'daemon-first')
    if (lastIds.length > 1) {
      frame(
        response,
        envelope('bob-uuid', 'same timestamp other sender'),
        'daemon-second'
      )
    }
  })

  const firstPlugin = createSignalChannel({
    SIGNAL_PROXY_AUTH: 'Bearer credential'
  })

  const chats = [{ chatId: 'direct:alice-uuid' }, { chatId: 'direct:bob-uuid' }]

  const first = await harness(
    firstPlugin,
    config(peer.base),
    chats,
    ['alice-uuid', 'bob-uuid'],
    `${peer.base}/dispatch`
  )

  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await first.storage.getState(
          { pluginId: 'channel-signal', ownerId: 'bot' },
          'events'
        )
      )?.value === 'daemon-first'
  )
  await firstPlugin.stop?.()
  await first.storage.close()

  const nextPlugin = createSignalChannel({
    SIGNAL_PROXY_AUTH: 'Bearer credential'
  })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    chats,
    ['alice-uuid', 'bob-uuid'],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await next.storage.getState(
          { pluginId: 'channel-signal', ownerId: 'bot' },
          'events'
        )
      )?.value === 'daemon-second'
  )
  await nextPlugin.stop?.()
  expect(lastIds).toEqual([undefined, 'daemon-first'])
  const requests = await next.storage.listInbound({ limit: 10 })
  expect(requests).toHaveLength(2)
  expect(
    requests.map((request) => request.snapshot.senderId).toSorted()
  ).toEqual(['alice-uuid', 'bob-uuid'])
})

it('preserves Last-Event-ID when valid ingest fails in real storage and replays after reopening', async () => {
  const lastIds: (string | undefined)[] = []
  let release: (() => void) | undefined
  const observation = observations()

  const peer = await httpPeer((request, response) => {
    const lastId = request.headers['last-event-id']
    lastIds.push(typeof lastId === 'string' ? lastId : undefined)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()

    const send = (): void => {
      frame(response, envelope('alice-uuid', 'recover me'), 'new-cursor')
    }

    if (lastIds.length === 1) {
      release = send
    } else {
      send()
    }
  })

  const firstPlugin = createSignalChannel({
    SIGNAL_PROXY_AUTH: 'Bearer credential'
  })

  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: 'direct:alice-uuid' }],
    ['alice-uuid'],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await first.storage.compareAndSetState(
    { pluginId: 'channel-signal', ownerId: 'bot' },
    { key: 'events', expectedVersion: null, value: 'old-cursor' }
  )
  await firstPlugin.start?.(new AbortController().signal)
  await waitFor(() => release !== undefined)
  await first.storage.close()
  release?.()
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'receive_failed'
    )
  )
  await firstPlugin.stop?.()

  const nextPlugin = createSignalChannel({
    SIGNAL_PROXY_AUTH: 'Bearer credential'
  })

  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: 'direct:alice-uuid' }],
    ['alice-uuid'],
    `${peer.base}/dispatch`,
    { filename: first.filename }
  )

  await nextPlugin.start?.(new AbortController().signal)
  await waitFor(
    async () =>
      (
        await next.storage.getState(
          { pluginId: 'channel-signal', ownerId: 'bot' },
          'events'
        )
      )?.value === 'new-cursor'
  )
  await nextPlugin.stop?.()
  expect(lastIds).toEqual(['old-cursor', 'old-cursor'])
  expect(
    (await next.storage.listInbound({ limit: 10 }))[0]?.snapshot.text
  ).toBe('recover me')
})

it.each(['mismatched-id', 'rpc-error'] as const)(
  'keeps %s unknown even when HTTP returns 200',
  async (mode) => {
    const peer = await httpPeer(async (request, response) => {
      const rpc = rpcRequestSchema.parse(await body(request))
      json(
        response,
        mode === 'mismatched-id'
          ? { jsonrpc: '2.0', id: 'another-call', result: { timestamp: 123 } }
          : {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32_603, message: 'upstream uncertain' }
            }
      )
    })

    const plugin = createSignalChannel({
      SIGNAL_PROXY_AUTH: 'Bearer credential'
    })

    await harness(
      plugin,
      config(peer.base),
      [{ chatId: 'direct:alice' }],
      ['alice'],
      `${peer.base}/dispatch`
    )
    expect((await plugin.send(sendInput(peer.base))).status).toBe('unknown')
  }
)

it.each([
  [429, 'retryable'],
  [403, 'rejected'],
  [503, 'unknown']
] as const)(
  'maps HTTP %i without resending ambiguous RPC effects',
  async (status, outcome) => {
    const peer = await httpPeer((_request, response) => {
      response.setHeader('Retry-After', '7')
      json(response, {}, status)
    })

    const plugin = createSignalChannel({
      SIGNAL_PROXY_AUTH: 'Bearer credential'
    })

    await harness(
      plugin,
      config(peer.base),
      [{ chatId: 'direct:alice' }],
      ['alice'],
      `${peer.base}/dispatch`
    )
    const result = await plugin.send(sendInput(peer.base))
    expect(result.status).toBe(outcome)
    if (result.status === 'retryable') {
      expect(result.retryAfterMs).toBe(7000)
    }
  }
)

it('diagnoses malformed SSE without advancing its durable replay cursor', async () => {
  const observation = observations()

  const peer = await httpPeer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('id: broken\ndata: {invalid-json\n\n')
  })

  const plugin = createSignalChannel({ SIGNAL_PROXY_AUTH: 'Bearer credential' })

  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: 'direct:alice' }],
    ['alice'],
    `${peer.base}/dispatch`,
    { observe: observation.observe }
  )

  await plugin.start?.(new AbortController().signal)
  await waitFor(() =>
    observation.logs.some(
      (entry) => entry.fields?.errorCode === 'receive_failed'
    )
  )
  await plugin.stop?.()
  expect(
    await fixture.storage.getState(
      { pluginId: 'channel-signal', ownerId: 'bot' },
      'events'
    )
  ).toBeUndefined()
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
  expect(() =>
    plugin.validateConfig({
      ...config(peer.base),
      authorization: 'inline-secret'
    })
  ).toThrow()
})
