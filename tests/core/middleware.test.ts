import { expect, it, vi } from 'vitest'
import type {
  MessageMiddleware,
  MiddlewareOutput
} from '../../packages/sdk/src/index.js'
import { required } from '../contracts/storage-contract.js'
import { incoming, picture } from './fixture.js'
import { middlewareFixture } from './middleware-fixture.js'

function prefix(id: string, value: string): MessageMiddleware {
  return {
    id,
    plan: () => value,
    async process({ message, options }) {
      return {
        text: `${typeof options === 'string' ? options : ''}${message.text}`,
        data: { applied: true }
      }
    }
  }
}

it.each(['dot', 'grok'] as const)(
  'keeps filtered messages out of %s notifications, reads and recovery after restart',
  async (agent) => {
    const later = vi.fn(prefix('later', 'must not run:').process)

    const filter = vi.fn<MessageMiddleware['process']>(
      async (): Promise<MiddlewareOutput> => null
    )

    const fx = await middlewareFixture(
      [
        prefix('first', 'prepared:'),
        { id: 'filter', plan: (): null => null, process: filter },
        { ...prefix('later', ''), process: later }
      ],
      agent
    )

    try {
      const receipt = await fx.channel.ingest({
        ...incoming,
        text: 'original',
        attachments: [picture]
      })

      await fx.runtime.processDue()
      expect(filter).toHaveBeenCalledOnce()
      expect(filter.mock.calls[0]?.[0].message.text).toBe('prepared:original')
      expect(later).not.toHaveBeenCalled()
      expect(fx.dispatched).toEqual([])

      const runtime = await fx.restart([])
      await runtime.processDue()
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(record.snapshot.text).toBe('original')
      expect(record.preparation).toHaveLength(2)
      expect(record.dispatch).toMatchObject({
        status: 'rejected',
        errorCode: 'middleware_filtered'
      })
      const principal = fx.principal()
      expect(
        (await principal.status({ requestId: receipt.requestId })).request
          ?.reply
      ).toEqual({
        status: 'rejected',
        errorCode: 'middleware_filtered'
      })
      expect(
        await principal.readMessages({ requestId: receipt.requestId })
      ).toEqual([])
      expect(await principal.readMessages()).toEqual([])
      expect(await principal.readMessages({ pending: true })).toEqual([])
      expect(
        await principal.sendMessage({
          channel: record.snapshot.channel.id,
          text: 'must not reply',
          reply: { requestId: receipt.requestId, kind: 'final' }
        })
      ).toEqual({ status: 'not_found' })
      expect(
        await fx.storage.requeue({
          kind: 'request',
          id: receipt.requestId,
          expectedVersion: record.version,
          now: Date.now(),
          acknowledgeUnknown: true
        })
      ).toEqual({ status: 'conflict' })
      await runtime.processDue()
      expect(fx.dispatched).toEqual([])
    } finally {
      await fx.close()
    }
  }
)

it('forwards attachments when middleware clears the text instead of returning null', async () => {
  const fx = await middlewareFixture([
    {
      id: 'clear',
      plan: (): null => null,
      process: async (): Promise<MiddlewareOutput> => ({ text: '' })
    }
  ])

  try {
    const receipt = await fx.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    await fx.runtime.processDue()
    const record = required(await fx.storage.getInbound(receipt.requestId))
    expect(fx.dispatched).toHaveLength(1)
    expect(fx.dispatched[0]?.text).toBe('')
    expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
    expect(record.snapshot.attachments).toHaveLength(1)
    expect(
      (await fx.principal().readMessages({ requestId: receipt.requestId }))[0]
    ).toMatchObject({
      text: '',
      reply: { status: 'awaiting_final' }
    })
  } finally {
    await fx.close()
  }
})

it('runs text middleware in captured order and reuses outputs after configuration changes', async () => {
  const first = prefix('first', 'A:')
  const second = prefix('second', 'B:')
  const fx = await middlewareFixture([first, second])
  try {
    const receipt = await fx.channel.ingest({ ...incoming, text: 'original' })

    const runtime = await fx.restart([
      prefix('second', 'new-B:'),
      prefix('first', 'new-A:')
    ])

    await runtime.processDue()
    expect(fx.dispatched[0]).toMatchObject({
      text: 'B:A:original',
      extensions: { first: { applied: true }, second: { applied: true } }
    })

    const [read] = await fx
      .principal()
      .readMessages({ requestId: receipt.requestId })

    expect(read).toMatchObject({
      text: 'B:A:original',
      extensions: { first: { applied: true }, second: { applied: true } }
    })
    expect(
      (await fx.storage.getInbound(receipt.requestId))?.snapshot.text
    ).toBe('original')
  } finally {
    await fx.close()
  }
})

it.each(['throw', 'invalid'] as const)(
  'continues the chain after a middleware %s without losing prior output',
  async (mode) => {
    const bad: MessageMiddleware = {
      id: 'broken',
      plan: () => null,
      async process() {
        if (mode === 'throw') {
          throw new Error('private middleware exception')
        }
        return { text: 'invalid', routing: 'must not escape' }
      }
    }

    const fx = await middlewareFixture([
      prefix('first', 'A:'),
      bad,
      prefix('last', 'C:')
    ])

    try {
      const receipt = await fx.channel.ingest({ ...incoming, text: 'original' })
      await fx.runtime.processDue()
      expect(fx.dispatched[0]).toMatchObject({ text: 'C:A:original' })
      expect(fx.dispatched[0]?.extensions).toEqual({
        first: { applied: true },
        last: { applied: true }
      })
      expect(
        (await fx.storage.getInbound(receipt.requestId))?.preparation?.[1]
      ).toEqual({
        id: 'broken',
        status: 'failed',
        errorCode: mode === 'throw' ? 'middleware_failed' : 'invalid_result'
      })
    } finally {
      await fx.close()
    }
  }
)

it('bounds a stalled chain, aborts processing and forwards the original media without a retry', async () => {
  let signal: AbortSignal | undefined

  const process = vi.fn(
    async (
      input: Parameters<MessageMiddleware['process']>[0]
    ): Promise<MiddlewareOutput> => {
      signal = input.signal
      return new Promise<MiddlewareOutput>(() => {})
    }
  )

  const fx = await middlewareFixture([
    { id: 'stalled', plan: (): null => null, process },
    prefix('never-started', 'bad:')
  ])

  try {
    const receipt = await fx.channel.ingest({
      ...incoming,
      text: 'original',
      attachments: [picture]
    })

    vi.useFakeTimers()
    const work = fx.runtime.processDue()
    await vi.advanceTimersByTimeAsync(10_001)
    await work
    expect(signal?.aborted).toBe(true)
    expect(fx.dispatched[0]?.text).toBe('original')
    const record = required(await fx.storage.getInbound(receipt.requestId))
    expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
    expect(record.preparation).toEqual([
      { id: 'stalled', status: 'failed', errorCode: 'timeout' },
      { id: 'never-started', status: 'failed', errorCode: 'timeout' }
    ])
    await fx.runtime.processDue()
    expect(process).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    await fx.close()
  }
})

it.each(['waiting', 'interrupted', 'disabled', 'replaced'] as const)(
  'recovers %s middleware after reopening real storage',
  async (mode) => {
    const process = vi.fn(prefix('prefix', 'prepared:').process)

    const plugin: MessageMiddleware = {
      ...prefix('prefix', 'prepared:'),
      process
    }

    const fx = await middlewareFixture([plugin])
    try {
      const receipt = await fx.channel.ingest({
        ...incoming,
        text: 'original',
        attachments: [picture]
      })

      if (mode === 'interrupted') {
        const now = Date.now()

        const [work] = await fx.storage.takeDue({
          now,
          leaseMs: 1000,
          limit: 1,
          leaseOwner: 'crashed',
          safeRetryAccountIds: []
        })

        expect(work?.kind).toBe('prepare')
        vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
      }

      let next: readonly MessageMiddleware[] = [plugin]
      if (mode === 'disabled') {
        next = []
      }
      if (mode === 'replaced') {
        next = [{ ...plugin, id: 'replacement' }]
      }

      const runtime = await fx.restart(next)
      await runtime.processDue()
      expect(fx.dispatched).toHaveLength(1)
      const record = required(await fx.storage.getInbound(receipt.requestId))
      expect(fx.dispatched[0]?.attachments).toEqual(record.snapshot.attachments)
      if (mode === 'waiting') {
        expect(process).toHaveBeenCalledOnce()
        expect(fx.dispatched[0]?.text).toBe('prepared:original')
      } else {
        expect(process).not.toHaveBeenCalled()
        expect(fx.dispatched[0]?.text).toBe('original')
        expect(record.preparation).toEqual([
          {
            id: 'prefix',
            status: 'failed',
            errorCode: mode === 'interrupted' ? 'interrupted' : 'disabled'
          }
        ])
      }
    } finally {
      vi.restoreAllMocks()
      await fx.close()
    }
  }
)

it('isolates plugin inputs from routing and raw snapshots and scopes media access to this message', async () => {
  const seen: unknown[] = []
  let foreignId = ''

  const plugin: MessageMiddleware = {
    id: 'inspect',
    plan(message): { version: number } | undefined {
      if (message.text !== 'original') {
        return undefined
      }
      Object.assign(message, {
        text: 'mutated selection',
        context: 'mutated context'
      })
      return { version: 1 }
    },
    async process({ message, options, readMedia }) {
      seen.push(
        Object.keys(message),
        await readMedia(foreignId),
        (await readMedia(required(message.attachments?.[0]).id))?.data
      )
      Object.assign(message, {
        text: 'mutated processing',
        attachments: [],
        channel: { id: 'other' }
      })
      if (options !== null && typeof options === 'object') {
        Object.assign(options, { version: 99 })
      }
      return { text: 'approved derived text' }
    }
  }

  const fx = await middlewareFixture([plugin])
  try {
    const foreign = await fx.channel.ingest({
      ...incoming,
      source: { ...incoming.source, eventId: 'other' },
      text: 'other',
      attachments: [picture]
    })

    const foreignSnapshot = required(
      await fx.storage.getInbound(foreign.requestId)
    ).snapshot

    foreignId = required(foreignSnapshot.attachments?.[0]).id
    expect(
      await fx.storage.media?.get(foreignSnapshot.channel.id, foreignId)
    ).toBeDefined()

    const receipt = await fx.channel.ingest({
      ...incoming,
      text: 'original',
      attachments: [picture]
    })

    const raw = required(
      await fx.storage.getInbound(receipt.requestId)
    ).snapshot

    await fx.runtime.processDue()
    expect(seen[0]).not.toContain('endpoint')
    expect(seen[0]).not.toContain('target')
    expect(seen[1]).toBeUndefined()
    expect(seen[2]).toEqual(picture.data)
    expect((await fx.storage.getInbound(receipt.requestId))?.snapshot).toEqual(
      raw
    )
    expect(fx.dispatched[1]).toMatchObject({
      text: 'approved derived text',
      channel: raw.channel,
      attachments: raw.attachments
    })
  } finally {
    await fx.close()
  }
})

it('skips failed selectors without withholding the original message', async () => {
  const process = vi.fn(prefix('broken', 'bad:').process)

  const fx = await middlewareFixture([
    {
      id: 'broken',
      plan(): never {
        throw new Error('selection failed')
      },
      process
    }
  ])

  try {
    await fx.channel.ingest({ ...incoming, text: 'original' })
    await fx.runtime.processDue()
    expect(process).not.toHaveBeenCalled()
    expect(fx.dispatched[0]?.text).toBe('original')
  } finally {
    await fx.close()
  }
})
