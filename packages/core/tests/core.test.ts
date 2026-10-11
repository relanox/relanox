import { noopObservability } from '@relanox/sdk'
import type {
  AgentHost,
  AgentPlugin,
  ChannelHost,
  ChannelPlugin,
  CompleteInput,
  InboundSnapshot,
  RelanoxConfig,
  Settlement,
  Storage
} from '@relanox/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  chunkText,
  createCore,
  resolveSecretRef,
  validateConfig
} from '../src/index.js'

it.each(['before', 'during'])(
  'cancels an inbound body aborted %s reading',
  async (timing) => {
    vi.useFakeTimers()
    let cancelled = false
    try {
      const runtime = await createCore({
        config: { ...config, accounts: [], endpoints: [], bindings: [] },
        storage: recordingStorage({}),
        channels: new Map(),
        agents: new Map(),
        worker: { callTimeoutMs: 1000, leaseMs: 2000 }
      })

      const controller = new AbortController()
      if (timing === 'before') {
        controller.abort()
      }

      const body = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelled = true
        }
      })

      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        body,
        signal: controller.signal,
        duplex: 'half'
      }

      const response = runtime.fetch(
        new Request('http://localhost/aborted', init)
      )

      if (timing === 'during') {
        controller.abort()
      }

      const bounded = Promise.race([
        response,
        new Promise<{ status: number }>((resolve) => {
          setTimeout(() => {
            resolve({ status: 0 })
          }, 100)
        })
      ])

      await vi.advanceTimersByTimeAsync(100)
      expect((await bounded).status).toBe(408)
      expect(cancelled).toBe(true)
    } finally {
      await vi.advanceTimersByTimeAsync(1000)
      vi.useRealTimers()
    }
  }
)

const config: RelanoxConfig = {
  accounts: [
    {
      id: 'bot',
      channel: 'telegram',
      config: { token: { env: 'BOT_TOKEN' } },
      allowedSenders: ['alice', 'bob']
    }
  ],
  endpoints: [
    {
      id: 'first',
      agent: 'grok',
      config: {
        authorization: { env: 'AGENT_TOKEN' },
        url: 'https://example.test/old'
      },
      dispatchMode: 'push'
    },
    { id: 'other', agent: 'dot', config: {}, dispatchMode: 'pull' }
  ],
  bindings: [
    {
      accountId: 'bot',
      chatId: 'chat',
      endpointId: 'first',
      allowedSenders: ['alice']
    }
  ],
  storage: { plugin: 'sqlite', config: {} },
  observability: { plugin: 'none', config: {} }
}

const incoming = {
  source: { channel: 'telegram' as const, accountId: 'bot', eventId: 'event' },
  senderId: 'alice',
  text: 'hello',
  target: {
    channel: 'telegram' as const,
    accountId: 'bot',
    chatId: 'chat',
    data: { durable: 'address' }
  },
  receivedAt: 1,
  context: null
}

const snapshot: InboundSnapshot = {
  ...incoming,
  requestId: 'req',
  endpoint: {
    id: 'first',
    agent: 'grok',
    config: {
      authorization: { env: 'AGENT_TOKEN' },
      url: 'https://example.test/old'
    },
    dispatchMode: 'push'
  },
  acceptedAt: 1
}

/** Records specified IO only. Any unplanned storage method throws; no storage state machine exists here. */
function recordingStorage(methods: Partial<Storage>): Storage {
  return new Proxy(methods, {
    get(target, key) {
      const method = target[key as keyof Storage]
      if (method) {
        return method
      }
      return () => {
        throw new Error(`Unexpected storage call ${String(key)}`)
      }
    }
  }) as Storage
}

function plugins(
  dispatch = vi
    .fn<AgentPlugin['dispatch']>()
    .mockResolvedValue({ status: 'accepted' })
): {
  channel: ChannelPlugin
  grok: AgentPlugin
  dot: AgentPlugin
  channels: Map<string, ChannelPlugin>
  agents: Map<'dot' | 'grok', AgentPlugin>
  readonly channelHost: ChannelHost
  readonly agentHost: AgentHost
} {
  let channelHost: ChannelHost | undefined
  let agentHost: AgentHost | undefined

  const channel: ChannelPlugin = {
    id: 'channel-telegram',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'telegram',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 3,
      lengthUnit: 'codepoint',
      idempotentSend: false
    },
    validateConfig: (value) => value as never,
    setup: async (host) => {
      channelHost = host
      host.mountHttp('/webhook', async () => new Response('channel'))
    },
    send: vi.fn().mockResolvedValue({ status: 'sent', receipt: {} })
  }

  const grok: AgentPlugin = {
    id: 'agent-grok',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'agent',
    agent: 'grok',
    validateConfig: (value) => value as never,
    setup: async (host) => {
      agentHost = host
      host.mountHttp('/mcp', async () => new Response('agent'))
    },
    dispatch
  }

  const dot: AgentPlugin = {
    ...grok,
    id: 'agent-dot',
    agent: 'dot',
    setup: async () => {}
  }

  return {
    channel,
    grok,
    dot,
    channels: new Map([['bot', channel]]),
    agents: new Map([
      ['grok' as const, grok],
      ['dot' as const, dot]
    ]),
    get channelHost() {
      if (!channelHost) {
        throw new Error('Not setup')
      }
      return channelHost
    },
    get agentHost() {
      if (!agentHost) {
        throw new Error('Not setup')
      }
      return agentHost
    }
  }
}

describe('configuration boundary', () => {
  it('rejects ambiguous/missing references and empty sender authorization; resolves explicit secrets only', () => {
    expect(() =>
      validateConfig({
        ...config,
        accounts: [...config.accounts, config.accounts[0]]
      })
    ).toThrow()
    expect(() =>
      validateConfig({
        ...config,
        bindings: [...config.bindings, config.bindings[0]]
      })
    ).toThrow()
    expect(() =>
      validateConfig({
        ...config,
        bindings: [{ ...config.bindings[0], endpointId: 'missing' }]
      })
    ).toThrow()
    expect(() =>
      validateConfig({
        ...config,
        accounts: [{ ...config.accounts[0], allowedSenders: [] }]
      })
    ).toThrow()
    expect(validateConfig(config).endpoints[0]?.config).toEqual({
      authorization: { env: 'AGENT_TOKEN' },
      url: 'https://example.test/old'
    })
    expect(resolveSecretRef({ env: 'TOKEN' }, { TOKEN: 'credential' })).toBe(
      'credential'
    )
    expect(() => resolveSecretRef({ env: 'TOKEN' }, {})).toThrow(
      'Missing environment secret'
    )
    for (const channel of [
      'telegram',
      'discord',
      'slack',
      'feishu',
      'wecom',
      'dingtalk',
      'qq',
      'msteams',
      'whatsapp',
      'matrix',
      'googlechat',
      'line',
      'mattermost',
      'signal',
      'irc'
    ]) {
      expect(
        validateConfig({
          ...config,
          accounts: [{ ...config.accounts[0], channel }]
        }).accounts[0]?.channel
      ).toBe(channel)
    }
  })
})

it.each([
  ['utf16', 3, ['a😀', '中b', '😀']],
  ['codepoint', 3, ['a😀中', 'b😀']],
  ['utf8', 5, ['a😀', '中b', '😀']]
] as const)('preserves Unicode under %s limits', (unit, maximum, expected) => {
  expect(chunkText('a😀中b😀', maximum, unit)).toEqual(expected)
  expect(() => chunkText('\uD800', maximum, unit)).toThrow('Malformed Unicode')
  expect(() => chunkText('😀', 1, 'utf16')).toThrow('cannot fit')
})

it('binds accounts, intersects principals, preserves snapshots and isolates routes', async () => {
  const accepted: InboundSnapshot[] = []

  const complete = vi
    .fn<(input: CompleteInput) => ReturnType<Storage['completeAndEnqueue']>>()
    .mockResolvedValue({
      status: 'completed',
      deliveryId: 'recorded',
      replay: false
    })

  const listPending = vi.fn<Storage['listPending']>().mockResolvedValue([])
  const p = plugins()

  const runtime = await createCore({
    config,
    channels: p.channels,
    agents: p.agents,
    worker: { maxHttpBodyBytes: 8 },
    observe: {
      log() {},
      count() {},
      record() {},
      span() {
        return {
          context: {
            traceparent:
              '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
          },
          end(): void {}
        }
      }
    },
    storage: recordingStorage({
      acceptInbound: async (value) => {
        accepted.push(value)
        return { requestId: value.requestId, duplicate: false }
      },
      listPending,
      getInbound: async () => ({
        snapshot,
        status: 'claimed',
        version: 2,
        dispatch: { status: 'accepted', attempts: 1, dueAt: 1 }
      }),
      completeAndEnqueue: complete
    })
  })

  await expect(
    p.channelHost.ingest({
      ...incoming,
      source: { ...incoming.source, accountId: 'foreign' }
    })
  ).rejects.toThrow('account_scope_mismatch')
  await expect(
    p.channelHost.ingest({ ...incoming, senderId: 'bob' })
  ).rejects.toThrow('sender_not_allowed')
  await p.channelHost.ingest(incoming)
  expect(accepted).toHaveLength(1)
  expect(accepted[0]?.trace).toEqual({
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
  })
  expect(accepted[0]?.endpoint.config).toEqual({
    authorization: { env: 'AGENT_TOKEN' },
    url: 'https://example.test/old'
  })
  incoming.target.data.durable = 'mutated'
  expect(accepted[0]?.target.data).toEqual({ durable: 'address' })
  incoming.target.data.durable = 'address'

  const scope = p.agentHost.forPrincipal({
    subject: 'verified',
    endpointIds: ['first', 'other', 'invented', 'first']
  })

  await scope.listPending(10)
  expect(listPending).toHaveBeenCalledWith({
    agent: 'grok',
    endpointIds: ['first'],
    limit: 10
  })
  expect(
    await p.agentHost
      .forPrincipal({ subject: 'verified', endpointIds: ['other'] })
      .complete({
        requestId: 'req',
        claimToken: 'token',
        resultId: 'final',
        text: 'no authority'
      })
  ).toEqual({ status: 'not_found' })
  expect(complete).not.toHaveBeenCalled()
  await scope.complete({
    requestId: 'req',
    claimToken: 'token',
    resultId: 'final',
    text: 'a😀中b😀'
  })
  const input = complete.mock.calls[0]?.[0]
  expect(input?.endpointIds).toEqual(['first'])
  expect(input?.agent).toBe('grok')
  expect(input?.outbound.target).toEqual(incoming.target)
  expect(input?.outbound.chunks.map((c) => c.text)).toEqual(['a😀中', 'b😀'])
  expect(input?.outbound.chunks.map((c) => c.idempotencyKey)).toEqual([
    `${input?.outbound.deliveryId}:0`,
    `${input?.outbound.deliveryId}:1`
  ])
  p.channelHost.mountHttp(
    '/bytes',
    async (request) => new Response(await request.arrayBuffer())
  )
  expect(
    await (
      await runtime.fetch(
        new Request('https://relay.test/channels/bot/webhook')
      )
    ).text()
  ).toBe('channel')
  expect(
    await (
      await runtime.fetch(new Request('https://relay.test/agents/grok/mcp'))
    ).text()
  ).toBe('agent')
  expect(
    (await runtime.fetch(new Request('https://relay.test/webhook'))).status
  ).toBe(404)

  const bytesResponse = await runtime.fetch(
    new Request('https://relay.test/channels/bot/bytes', {
      method: 'POST',
      body: new Uint8Array([0, 255, 123])
    })
  )

  expect([...new Uint8Array(await bytesResponse.arrayBuffer())]).toEqual([
    0, 255, 123
  ])
  expect(
    (
      await runtime.fetch(
        new Request('https://relay.test/channels/bot/bytes', {
          method: 'POST',
          headers: { 'content-length': '1' },
          body: '123456789'
        })
      )
    ).status
  ).toBe(413)
  runtime.setAccepting(false)
  expect(
    (
      await runtime.fetch(
        new Request('https://relay.test/channels/bot/webhook')
      )
    ).status
  ).toBe(503)
})

it("reports connection diagnostics and recovery through the registered plugin's observability", async () => {
  const p = plugins()
  const log = vi.fn()
  await createCore({
    config,
    channels: p.channels,
    agents: p.agents,
    storage: recordingStorage({}),
    observe: { ...noopObservability, log }
  })
  p.channelHost.connection('degraded', 'network')
  expect(log).toHaveBeenLastCalledWith('warn', 'connection.changed', {
    plugin: 'channel-telegram',
    outcome: 'error',
    errorCode: 'network'
  })
  p.channelHost.connection('connected')
  expect(log).toHaveBeenLastCalledWith('info', 'connection.changed', {
    plugin: 'channel-telegram',
    outcome: 'ok'
  })
})

it("binds mutations to the principal agent and rejects a reused endpoint's foreign snapshot", async () => {
  const p = plugins()

  const claimRequest = vi
    .fn<Storage['claimRequest']>()
    .mockResolvedValue({ status: 'not_found' })

  const fail = vi
    .fn<Storage['fail']>()
    .mockResolvedValue({ status: 'not_found' })

  await createCore({
    config,
    channels: p.channels,
    agents: p.agents,
    storage: recordingStorage({
      claimRequest,
      fail,
      getInbound: async () => ({
        snapshot: {
          ...snapshot,
          endpoint: { ...snapshot.endpoint, agent: 'dot' }
        },
        status: 'claimed',
        version: 2,
        dispatch: { status: 'accepted', attempts: 1, dueAt: 1 }
      })
    })
  })

  const host = p.agentHost.forPrincipal({
    subject: 'verified',
    endpointIds: ['first']
  })

  await host.claim('req', 'key')
  expect(claimRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'req',
      endpointIds: ['first'],
      agent: 'grok'
    })
  )
  await host.fail({
    requestId: 'req',
    claimToken: 'token',
    errorCode: 'failed'
  })
  expect(fail).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'req',
      endpointIds: ['first'],
      agent: 'grok'
    })
  )
  expect(
    await host.complete({
      requestId: 'req',
      claimToken: 'token',
      resultId: 'final',
      text: 'answer'
    })
  ).toEqual({ status: 'not_found' })
})

it('validates every endpoint before registering any traffic and keeps setup config separate', async () => {
  const p = plugins()
  const setup = vi.spyOn(p.channel, 'setup')
  p.dot.validateConfig = (): never => {
    throw new Error('invalid endpoint')
  }
  await expect(
    createCore({
      config,
      channels: p.channels,
      agents: p.agents,
      storage: recordingStorage({})
    })
  ).rejects.toThrow('invalid endpoint')
  expect(setup).not.toHaveBeenCalled()
  p.dot.validateConfig = (value): never => value as never
  const agentSetup = vi.spyOn(p.grok, 'setup')
  await createCore({
    config,
    channels: p.channels,
    agents: p.agents,
    storage: recordingStorage({})
  })
  expect(agentSetup.mock.calls[0]?.[2]).toEqual({})
  expect(agentSetup.mock.calls[0]?.[1]).toEqual([config.endpoints[0]])
})

it('passes lease fences, clamps retry delay, enforces budgets and isolates observers', async () => {
  const lease = { token: 'lease', version: 7, expiresAt: Date.now() + 30_000 }

  const takeDue = vi
    .fn<Storage['takeDue']>()
    .mockResolvedValueOnce([
      {
        kind: 'dispatch',
        record: {
          snapshot,
          version: 7,
          status: 'pending',
          dispatch: { status: 'due', attempts: 1, dueAt: 0 }
        },
        lease
      }
    ])
    .mockResolvedValue([])

  const settlements: Settlement[] = []

  const p = plugins(
    vi.fn().mockResolvedValue({
      status: 'retryable',
      errorCode: 'rate_limit',
      retryAfterMs: 999_999
    })
  )

  const runtime = await createCore({
    config,
    channels: p.channels,
    agents: p.agents,
    storage: recordingStorage({
      takeDue,
      settleAttempt: async (input) => {
        settlements.push(input)
        return { status: 'updated', version: 8 }
      },
      getStats: async () => ({
        pending: 1,
        claimed: 0,
        undelivered: 0,
        unknown: 0
      })
    }),
    worker: { retryMaxMs: 5000 },
    observe: {
      log() {
        throw new Error('collector unavailable')
      },
      count() {
        throw new Error('collector unavailable')
      },
      record() {
        throw new Error('collector unavailable')
      },
      span() {
        throw new Error('collector unavailable')
      }
    }
  })

  expect(await runtime.processDue()).toEqual({ processed: 1, conflicts: 0 })
  expect(settlements[0]?.lease).toEqual(lease)
  expect((settlements[0]?.nextDueAt ?? 0) - (settlements[0]?.now ?? 0)).toBe(
    5000
  )
  expect(takeDue.mock.calls[0]?.[0].limit).toBe(1)
  takeDue.mockResolvedValueOnce([
    {
      kind: 'dispatch',
      record: {
        snapshot,
        version: 8,
        status: 'pending',
        dispatch: { status: 'due', attempts: 8, dueAt: 0 }
      },
      lease
    }
  ])
  await runtime.processDue()
  expect(settlements[1]?.outcome).toEqual({
    status: 'rejected',
    errorCode: 'retry_budget_exhausted'
  })
  expect(p.grok.dispatch).toHaveBeenCalledOnce()
})

it('aborts bounded transport calls and preserves unknown effects', async () => {
  vi.useFakeTimers()
  try {
    const lease = { token: 'lease', version: 7, expiresAt: Date.now() + 30_000 }

    const takeDue = vi
      .fn<Storage['takeDue']>()
      .mockResolvedValueOnce([
        {
          kind: 'dispatch',
          record: {
            snapshot,
            version: 7,
            status: 'pending',
            dispatch: { status: 'due', attempts: 0, dueAt: 0 }
          },
          lease
        }
      ])
      .mockResolvedValue([])

    const settleAttempt = vi
      .fn<Storage['settleAttempt']>()
      .mockResolvedValue({ status: 'updated', version: 8 })

    const dispatch = vi
      .fn<AgentPlugin['dispatch']>()
      .mockReturnValue(new Promise(() => {}))

    const p = plugins(dispatch)

    const runtime = await createCore({
      config,
      channels: p.channels,
      agents: p.agents,
      storage: recordingStorage({
        takeDue,
        settleAttempt,
        getStats: async () => ({
          pending: 1,
          claimed: 0,
          undelivered: 0,
          unknown: 1
        })
      }),
      worker: { callTimeoutMs: 20 }
    })

    const processing = runtime.processDue()
    await vi.advanceTimersByTimeAsync(21)
    await processing
    expect(dispatch.mock.calls[0]?.[0].signal.aborted).toBe(true)
    expect(settleAttempt.mock.calls[0]?.[0].outcome).toEqual({
      status: 'unknown',
      errorCode: 'call_timeout'
    })
    expect(settleAttempt.mock.calls[0]?.[0].lease).toEqual(lease)
  } finally {
    vi.useRealTimers()
  }
})
