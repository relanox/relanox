import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  DueWork,
  EnqueueMessageInput,
  InboundSnapshot,
  ConversationRecord,
  Storage
} from '../../packages/sdk/src/index.js'

export function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Required durable record is absent')
  }
  return value
}

export const snapshot = (
  id = 'r1',
  at = 100,
  endpoint = 'ep',
  channelId = endpoint === 'ep' ? 'channel' : endpoint
): InboundSnapshot => ({
  requestId: id,
  channel: {
    id: channelId,
    platform: 'telegram',
    accountId: 'a',
    chatId: `chat-${channelId}`
  },
  source: { channel: 'telegram', accountId: 'a', eventId: id },
  senderId: 'u',
  text: 'question',
  target: {
    channel: 'telegram',
    accountId: 'a',
    chatId: `chat-${channelId}`,
    data: { thread: 'original' }
  },
  receivedAt: at,
  acceptedAt: at,
  context: { original: true },
  endpoint: {
    id: endpoint,
    agent: 'grok',
    config: { url: 'https://agent.example', secret: { env: 'TOKEN' } }
  }
})

export const completion = (
  channelId = 'channel',
  messageId = 'message',
  endpoint = 'ep'
): EnqueueMessageInput => ({
  channelId,
  agent: 'grok',
  endpointIds: [endpoint],
  message: { messageId, text: 'AB', createdAt: 110 },
  outbound: {
    deliveryId: `d-${channelId}-${messageId}`,
    channelId,
    endpoint: snapshot('r1', 100, endpoint, channelId).endpoint,
    messageId,
    target: snapshot('r1', 100, endpoint, channelId).target,
    chunks: [
      { text: 'A', idempotencyKey: 'c1', state: { seq: 1 } },
      { text: 'B', idempotencyKey: 'c2', state: { seq: 2 } }
    ],
    currentChunk: 0,
    receipts: [],
    status: 'pending',
    version: 1,
    attempts: 0,
    dueAt: 110,
    createdAt: 110
  }
})

export const testConversations: readonly ConversationRecord[] = [
  ['channel', 'ep'],
  ['independent', 'ep'],
  ['other', 'other'],
  ['ep2', 'ep2']
].map(([id, endpoint]) => {
  const input = snapshot('setup', 100, endpoint, id)
  return { address: input.channel, endpoint: input.endpoint }
})

export function storageContract(
  name: string,
  open: () => Promise<Storage>
): void {
  describe(name, () => {
    let s: Storage
    beforeEach(async () => {
      s = await open()
      await s.initialize()
      await s.registerConversations(testConversations)
    })
    afterEach(async () => {
      await s.close()
    })

    it('lists recent inputs by acceptance time with an ID tie-break, scoped before limiting', async () => {
      await s.acceptInbound(snapshot('z-old', 100))
      await s.acceptInbound(snapshot('a-new', 200))
      await s.acceptInbound(snapshot('b-new', 200))
      await s.acceptInbound(snapshot('foreign', 300, 'ep2'))

      const result = await s.listInbound({
        endpointId: 'ep',
        limit: 2,
        recent: true
      })

      expect(result.map((record) => record.snapshot.requestId)).toEqual([
        'b-new',
        'a-new'
      ])
      expect(
        (await s.listInbound({ endpointId: 'ep', limit: 2 })).map(
          (record) => record.snapshot.requestId
        )
      ).toEqual(['a-new', 'b-new'])
      await expect(
        s.listInbound({ limit: 1, recent: true, afterId: 'a-new' })
      ).rejects.toThrow('recent_cursor_unsupported')
    })

    const due = async (
      now = 110,
      safeRetryAccountIds: string[] = []
    ): Promise<readonly DueWork[]> =>
      s.takeDue({
        now,
        leaseMs: 10,
        limit: 10,
        leaseOwner: 'worker',
        safeRetryAccountIds
      })

    const dispatch = async (id = 'r1'): Promise<void> => {
      const w = required(
        (await due(100)).find(
          (item) =>
            item.kind === 'dispatch' && item.record.snapshot.requestId === id
        )
      )

      await s.settleAttempt({
        kind: 'dispatch',
        id,
        lease: w.lease,
        outcome: { status: 'accepted' },
        now: 101,
        nextDueAt: 102
      })
    }

    it('registers channels independently, learns authenticated targets atomically and revokes removed ownership', async () => {
      expect(await s.getConversation('channel')).toEqual({
        address: {
          id: 'channel',
          platform: 'telegram',
          accountId: 'a',
          chatId: 'chat-channel'
        },
        endpoint: {
          id: 'ep',
          agent: 'grok',
          config: { url: 'https://agent.example', secret: { env: 'TOKEN' } }
        }
      })
      await s.acceptInbound(snapshot())
      expect((await s.getConversation('channel'))?.target).toEqual({
        channel: 'telegram',
        accountId: 'a',
        chatId: 'chat-channel',
        data: { thread: 'original' }
      })
      await s.registerConversations(testConversations)
      expect((await s.getConversation('channel'))?.target?.data).toEqual({
        thread: 'original'
      })
      await expect(
        s.acceptInbound({
          ...snapshot('forged'),
          target: { ...snapshot().target, chatId: 'other' }
        })
      ).rejects.toThrow('Unauthorized inbound conversation')
      expect(await s.getInbound('forged')).toBeUndefined()
      expect((await s.getConversation('channel'))?.target?.chatId).toBe(
        'chat-channel'
      )
      const queued = await s.enqueueMessage(completion())
      expect(queued).toMatchObject({ status: 'queued', replay: false })
      await s.registerConversations(
        testConversations.filter((record) => record.address.id !== 'channel')
      )
      expect(await s.getConversation('channel')).toBeUndefined()
      expect(
        (await s.getConversation('channel', { includeInactive: true }))?.address
          .chatId
      ).toBe('chat-channel')
      expect(await s.enqueueMessage(completion('channel', 'new'))).toEqual({
        status: 'not_found'
      })
      expect(await s.getMessageReceipt(completion())).toEqual({
        status: 'not_found'
      })
      expect((await s.getOutbound('d-channel-message'))?.target.chatId).toBe(
        'chat-channel'
      )
      await s.registerConversations(testConversations)
      expect((await s.getConversation('channel'))?.target?.data).toEqual({
        thread: 'original'
      })
      await expect(
        s.registerConversations([
          {
            address: snapshot().channel,
            endpoint: { id: 'foreign', agent: 'dot', config: null }
          }
        ])
      ).rejects.toThrow('Channel identity cannot change ownership')
      expect((await s.getConversation('channel'))?.endpoint.id).toBe('ep')
    })

    it('deduplicates source keys and freezes serializable input without sharing mutable caller objects', async () => {
      const context = { original: true }
      const original = { ...snapshot(), context }
      await s.acceptInbound(original)
      expect(
        await s.acceptInbound({ ...snapshot('other'), source: original.source })
      ).toEqual({ requestId: 'r1', duplicate: true })
      expect((await s.getInbound('r1'))?.snapshot).toEqual(original)
      context.original = false
      expect((await s.getInbound('r1'))?.snapshot.context).toEqual({
        original: true
      })
      expect(await s.getInbound('other')).toBeUndefined()
      expect(await s.getStats()).toEqual({
        pending: 1,
        undelivered: 0,
        unknown: 0,
        oldestPendingAt: 100
      })
    })

    it('queues multiple scoped messages per channel without requiring inbound input and replays identical keys but conflicts changed content', async () => {
      const input = completion()

      const results = await Promise.all([
        s.enqueueMessage(input),
        s.enqueueMessage(input)
      ])

      expect(results).toEqual(
        expect.arrayContaining([
          {
            status: 'queued',
            deliveryId: input.outbound.deliveryId,
            replay: false
          },
          {
            status: 'queued',
            deliveryId: input.outbound.deliveryId,
            replay: true
          }
        ])
      )
      expect(
        await s.enqueueMessage({
          ...input,
          message: { ...input.message, text: 'different' }
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await s.enqueueMessage(completion('channel', 'second'))
      ).toMatchObject({
        status: 'queued',
        replay: false
      })
      expect(await s.listOutbound({ limit: 10 })).toHaveLength(2)
      expect(
        await s.enqueueMessage({
          ...completion('channel', 'third'),
          endpointIds: ['other']
        })
      ).toEqual({ status: 'unauthorized' })
      expect(
        await s.enqueueMessage({
          ...completion('channel', 'third'),
          agent: 'dot'
        })
      ).toEqual({ status: 'unauthorized' })
      expect(await s.enqueueMessage(completion('missing'))).toEqual({
        status: 'not_found'
      })
    })

    it('stores formatted Markdown parts while deduplicating by the original reply', async () => {
      await s.acceptInbound(snapshot())
      const original = completion()

      const input = {
        ...original,
        message: { ...original.message, text: '**alpha beta**' },
        outbound: {
          ...original.outbound,
          chunks: [
            { text: '**alpha** ', idempotencyKey: 'c1', state: null },
            { text: '**beta**', idempotencyKey: 'c2', state: null }
          ]
        }
      }

      expect(await s.enqueueMessage(input)).toEqual({
        status: 'queued',
        deliveryId: 'd-channel-message',
        replay: false
      })
      expect((await s.listOutbound({ limit: 10 }))[0]?.chunks).toEqual([
        { text: '**alpha** ', idempotencyKey: 'c1', state: null },
        { text: '**beta**', idempotencyKey: 'c2', state: null }
      ])
      expect(await s.enqueueMessage(input)).toEqual({
        status: 'queued',
        deliveryId: 'd-channel-message',
        replay: true
      })
      expect(
        await s.enqueueMessage({
          ...input,
          message: { ...input.message, text: '**different**' }
        })
      ).toEqual({ status: 'conflict' })
    })

    it('rejects forged targets, empty plans and initial delivery state before queue publication', async () => {
      await s.acceptInbound(snapshot())
      const input = completion()
      for (const change of [
        { target: { ...input.outbound.target, chatId: 'foreign' } },
        { currentChunk: 1 },
        { createdAt: 999 },
        { receipts: [{}] },
        { version: 2 },
        { chunks: [] }
      ]) {
        expect(
          await s.enqueueMessage({
            ...input,
            outbound: { ...input.outbound, ...change }
          })
        ).toEqual({ status: 'conflict' })
      }
      expect(await s.listOutbound({ limit: 10 })).toEqual([])
      expect(await s.enqueueMessage(input)).toMatchObject({ status: 'queued' })
    })

    it('dispatches independent messages on the same endpoint and never automatically repeats accepted effects', async () => {
      await s.acceptInbound(snapshot())
      await s.acceptInbound(snapshot('r2', 100))
      const work = await due(100)
      expect(
        work.map((item) =>
          item.kind === 'dispatch' ? item.record.snapshot.requestId : ''
        )
      ).toEqual(['r1', 'r2'])
      for (const item of work) {
        if (item.kind === 'dispatch') {
          await s.settleAttempt({
            kind: 'dispatch',
            id: item.record.snapshot.requestId,
            lease: item.lease,
            outcome: { status: 'accepted' },
            now: 101,
            nextDueAt: 102
          })
        }
      }
      expect(await due(1000)).toEqual([])
      expect(
        await s.listInbound({ dispatchStatus: 'accepted', limit: 10 })
      ).toHaveLength(2)
      expect((await s.getStats()).pending).toBe(0)
      const record = required(await s.getInbound('r1'))
      expect(
        await s.requeue({
          kind: 'request',
          id: 'r1',
          expectedVersion: record.version,
          now: 1001,
          acknowledgeUnknown: false
        })
      ).toMatchObject({ status: 'updated' })
      expect((await due(1001)).map((item) => item.kind)).toEqual(['dispatch'])
    })

    it('fences stale dispatch settlements and requires explicit unknown recovery while retryable work respects its due date', async () => {
      await s.acceptInbound(snapshot())
      const first = required((await due(100))[0])
      expect(await due(110)).toEqual([])
      const record = required(await s.getInbound('r1'))
      expect(record.dispatch.status).toBe('unknown')
      expect(
        await s.settleAttempt({
          kind: 'dispatch',
          id: 'r1',
          lease: first.lease,
          outcome: { status: 'accepted' },
          now: 111,
          nextDueAt: 111
        })
      ).toEqual({ status: 'conflict' })

      const recovery = {
        kind: 'request' as const,
        id: 'r1',
        expectedVersion: record.version,
        now: 111,
        acknowledgeUnknown: false
      }

      expect(await s.requeue(recovery)).toEqual({ status: 'conflict' })
      expect(
        await s.requeue({ ...recovery, acknowledgeUnknown: true })
      ).toMatchObject({ status: 'updated' })
      const retry = required((await due(111))[0])
      await s.settleAttempt({
        kind: 'dispatch',
        id: 'r1',
        lease: retry.lease,
        outcome: { status: 'retryable', errorCode: 'rate_limit' },
        now: 112,
        nextDueAt: 150
      })
      expect(await due(149)).toEqual([])
      expect(await due(150)).toHaveLength(1)
    })

    it('preserves partial receipts and idempotency keys through ambiguous-send recovery', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      const input = completion()
      await s.enqueueMessage(input)
      const first = required((await due())[0])
      await s.settleAttempt({
        kind: 'send',
        id: input.outbound.deliveryId,
        lease: first.lease,
        outcome: { status: 'sent', receipt: { platformMessageId: 'first' } },
        now: 111,
        nextDueAt: 112
      })
      const second = required((await due(112))[0])
      expect(await due(122)).toEqual([])
      const record = required(await s.getOutbound(input.outbound.deliveryId))
      expect(record).toMatchObject({
        status: 'unknown',
        currentChunk: 1,
        receipts: [{ platformMessageId: 'first' }]
      })
      expect(
        await s.requeue({
          kind: 'delivery',
          id: record.deliveryId,
          expectedVersion: record.version,
          now: 123,
          acknowledgeUnknown: true
        })
      ).toMatchObject({ status: 'updated' })
      const retry = required((await due(123))[0])
      if (retry.kind === 'send') {
        expect(retry.record.chunks[1]?.idempotencyKey).toBe('c2')
      }
      expect(
        await s.settleAttempt({
          kind: 'send',
          id: record.deliveryId,
          lease: second.lease,
          outcome: { status: 'sent', receipt: {} },
          now: 124,
          nextDueAt: 124
        })
      ).toEqual({ status: 'conflict' })
      await s.settleAttempt({
        kind: 'send',
        id: record.deliveryId,
        lease: retry.lease,
        outcome: { status: 'sent', receipt: { platformMessageId: 'second' } },
        now: 124,
        nextDueAt: 124
      })
      expect((await s.getOutbound(record.deliveryId))?.status).toBe('sent')
    })

    // Reject malformed numeric bounds before leasing; NaN can disable limit comparisons.
    // Existing cases only use positive integer limits and cannot catch a whole-backlog claim.
    // The real public storage API supplies the regression seam; no production seam is added.
    it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects an invalid work limit %s without taking a lease',
      async (limit) => {
        await s.acceptInbound(snapshot())
        await expect(
          s.takeDue({
            now: 100,
            leaseMs: 10,
            limit,
            leaseOwner: 'invalid',
            safeRetryAccountIds: []
          })
        ).rejects.toThrow('Invalid storage limit')
        expect(await due(100)).toMatchObject([
          { kind: 'dispatch', record: { snapshot: { requestId: 'r1' } } }
        ])
      }
    )

    // Keep runnable work reachable when restart recovery exceeds a claim's result limit.
    // A bounded combined scan could hide runnable work behind expired claims.
    // Existing single-expiry cases do not cover that backlog. No new seam is needed.
    it('claims runnable work behind an expired request backlog without repeating uncertain calls', async () => {
      const ids = ['expired-a', 'expired-b', 'expired-c']
      for (const id of ids) {
        await s.acceptInbound(snapshot(id))
      }
      const expired = await due(100)
      expect(expired).toHaveLength(3)
      await s.acceptInbound(snapshot('runnable', 105))

      const work = await s.takeDue({
        now: 110,
        leaseMs: 10,
        limit: 1,
        leaseOwner: 'restarted',
        safeRetryAccountIds: []
      })

      expect(work).toMatchObject([
        { kind: 'dispatch', record: { snapshot: { requestId: 'runnable' } } }
      ])
      for (const [index, id] of ids.entries()) {
        const item = required(expired[index])
        expect(
          await s.settleAttempt({
            kind: 'dispatch',
            id,
            lease: item.lease,
            outcome: { status: 'accepted' },
            now: 110,
            nextDueAt: 110
          })
        ).toEqual({ status: 'conflict' })
      }
    })

    // Both adapters must support long sends without delaying notification recovery.
    // Shared-lease cases cannot catch this split; this uses only real storage APIs.
    it('leases sends longer than notifications and permits their late settlement', async () => {
      await s.acceptInbound(snapshot())
      await s.enqueueMessage(completion())

      const work = await s.takeDue({
        now: 110,
        leaseMs: 30_000,
        sendLeaseMs: 630_000,
        limit: 2,
        leaseOwner: 'long-send',
        safeRetryAccountIds: []
      })

      const sending = required(work.find((item) => item.kind === 'send'))
      expect(
        required(work.find((item) => item.kind === 'dispatch')).lease.expiresAt
      ).toBe(30_110)
      expect(sending.lease.expiresAt).toBe(630_110)
      expect(await due(45_110)).toEqual([])
      expect((await s.getInbound('r1'))?.dispatch.status).toBe('unknown')
      expect(
        await s.settleAttempt({
          kind: 'send',
          id: 'd-channel-message',
          lease: sending.lease,
          outcome: { status: 'sent', receipt: { platformMessageId: 'slow' } },
          now: 45_111,
          nextDueAt: 45_111
        })
      ).toMatchObject({ status: 'updated' })
      expect(await s.getOutbound('d-channel-message')).toMatchObject({
        currentChunk: 1,
        receipts: [{ platformMessageId: 'slow' }]
      })
    })

    it('allows lease expiry retry only for durable idempotent-send accounts', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      await s.enqueueMessage(completion())
      const original = required((await due())[0])
      const recovered = required((await due(120, ['a']))[0])
      expect(recovered.kind).toBe('send')
      expect(recovered.lease.token).not.toBe(original.lease.token)
    })

    it('defers a pending platform retrieval without spending a retry attempt or advancing the delivery', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      await s.enqueueMessage(completion())
      const first = required((await due(110))[0])
      await s.settleAttempt({
        kind: 'send',
        id: 'd-channel-message',
        lease: first.lease,
        outcome: { status: 'retryable', errorCode: 'temporary_failure' },
        now: 111,
        nextDueAt: 120
      })
      const pending = required((await due(120))[0])
      await s.settleAttempt({
        kind: 'send',
        id: 'd-channel-message',
        lease: pending.lease,
        outcome: { status: 'pending', retryAfterMs: 30 },
        now: 121,
        nextDueAt: 151
      })
      expect(await s.getOutbound('d-channel-message')).toMatchObject({
        status: 'pending',
        attempts: 1,
        dueAt: 151,
        currentChunk: 0,
        receipts: []
      })
      expect(await due(150)).toEqual([])
      expect((await due(151)).map((item) => item.kind)).toEqual(['send'])
    })

    it('sends each channel in enqueue order despite reversed IDs and holds later messages behind leased, future or unknown predecessors', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      const first = completion('channel', 'z-first')
      const second = completion('channel', 'a-second')
      await s.enqueueMessage(first)
      await s.enqueueMessage(second)
      await s.acceptInbound(snapshot('independent', 100, 'ep', 'independent'))
      await dispatch('independent')
      const independent = completion('independent')
      await s.enqueueMessage(independent)
      const work = await due(110)
      expect(
        work
          .filter((item) => item.kind === 'send')
          .map((item) => item.record.deliveryId)
      ).toEqual([first.outbound.deliveryId, independent.outbound.deliveryId])
      expect(await due(111)).toEqual([])

      const firstWork = required(
        work.find(
          (item) => item.kind === 'send' && item.record.channelId === 'channel'
        )
      )

      await s.settleAttempt({
        kind: 'send',
        id: first.outbound.deliveryId,
        lease: firstWork.lease,
        outcome: { status: 'retryable', errorCode: 'rate_limit' },
        now: 111,
        nextDueAt: 150
      })
      expect(await due(120)).toEqual([])

      const retry = required(
        (await due(150)).find((item) => item.kind === 'send')
      )

      await s.settleAttempt({
        kind: 'send',
        id: first.outbound.deliveryId,
        lease: retry.lease,
        outcome: { status: 'unknown', errorCode: 'timeout' },
        now: 151,
        nextDueAt: 151
      })
      expect(await due(152)).toEqual([])
      const record = required(await s.getOutbound(first.outbound.deliveryId))
      await s.requeue({
        kind: 'delivery',
        id: record.deliveryId,
        expectedVersion: record.version,
        now: 153,
        acknowledgeUnknown: true
      })
      for (let index = 0; index < 2; index++) {
        const next = required((await due(153))[0])
        expect(next.kind === 'send' ? next.record.deliveryId : '').toBe(
          first.outbound.deliveryId
        )
        await s.settleAttempt({
          kind: 'send',
          id: first.outbound.deliveryId,
          lease: next.lease,
          outcome: { status: 'sent', receipt: {} },
          now: 154,
          nextDueAt: 153
        })
      }
      const next = required((await due(153))[0])
      expect(next.kind === 'send' ? next.record.deliveryId : '').toBe(
        second.outbound.deliveryId
      )
    })

    it.each(['qq_duplicate_effect', 'lease_expired'])(
      'releases later QQ deliveries after %s without retrying the uncertain reply',
      async (errorCode) => {
        const input = snapshot('r1', 100, 'ep', 'qq-channel')

        const incoming: InboundSnapshot = {
          ...input,
          channel: { ...input.channel, platform: 'qq' },
          source: { ...input.source, channel: 'qq' },
          target: { ...input.target, channel: 'qq' }
        }

        await s.registerConversations([
          { address: incoming.channel, endpoint: incoming.endpoint }
        ])
        await s.acceptInbound(incoming)
        await dispatch()
        for (const messageId of ['z-first', 'a-second']) {
          const message = completion('qq-channel', messageId)
          expect(
            await s.enqueueMessage({
              ...message,
              outbound: { ...message.outbound, target: incoming.target }
            })
          ).toMatchObject({ status: 'queued' })
        }
        const first = required((await due(110))[0])
        expect(first).toMatchObject({
          kind: 'send',
          record: { deliveryId: 'd-qq-channel-z-first', currentChunk: 0 }
        })
        expect(await due(111)).toEqual([])
        await s.settleAttempt({
          kind: 'send',
          id: 'd-qq-channel-z-first',
          lease: first.lease,
          outcome: {
            status: 'sent',
            receipt: { platformMessageId: 'qq-text' }
          },
          now: 111,
          nextDueAt: 120
        })
        expect(await due(119)).toEqual([])
        const unfinished = required((await due(120))[0])
        if (errorCode === 'qq_duplicate_effect') {
          await s.settleAttempt({
            kind: 'send',
            id: 'd-qq-channel-z-first',
            lease: unfinished.lease,
            outcome: { status: 'unknown', errorCode },
            now: 121,
            nextDueAt: 121
          })
        }
        // SQLite expires a lease before making the next delivery eligible on the next tick.
        const released = [...(await due(130)), ...(await due(131))]
        expect(released).toMatchObject([
          {
            kind: 'send',
            record: { deliveryId: 'd-qq-channel-a-second', currentChunk: 0 }
          }
        ])
        expect(await due(132)).toEqual([])
        const uncertain = required(await s.getOutbound('d-qq-channel-z-first'))
        expect(uncertain).toMatchObject({
          status: 'unknown',
          errorCode,
          currentChunk: 1,
          receipts: [{ platformMessageId: 'qq-text' }]
        })
        expect(
          await s.requeue({
            kind: 'delivery',
            id: uncertain.deliveryId,
            expectedVersion: uncertain.version,
            now: 132,
            acknowledgeUnknown: false
          })
        ).toEqual({ status: 'conflict' })
        await s.settleAttempt({
          kind: 'send',
          id: 'd-qq-channel-a-second',
          lease: required(released[0]).lease,
          outcome: { status: 'rejected', errorCode: 'test_finished' },
          now: 132,
          nextDueAt: 132
        })
        expect(
          await s.requeue({
            kind: 'delivery',
            id: uncertain.deliveryId,
            expectedVersion: uncertain.version,
            now: 133,
            acknowledgeUnknown: true
          })
        ).toMatchObject({ status: 'updated' })
        expect(await due(133)).toMatchObject([
          {
            kind: 'send',
            record: {
              deliveryId: 'd-qq-channel-z-first',
              currentChunk: 1,
              receipts: [{ platformMessageId: 'qq-text' }]
            }
          }
        ])
      }
    )

    it('redacts completed inputs and deliveries independently while preserving pending content and channel dedupe', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      const first = completion()
      const second = completion('channel', 'second')
      await s.enqueueMessage(first)
      await s.enqueueMessage(second)
      expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
        redacted: 1
      })
      expect(
        (await s.getOutbound(second.outbound.deliveryId))?.chunks[0]?.text
      ).toBe('A')
      for (let index = 0; index < 4; index++) {
        const item = required(
          (await due(110)).find((work) => work.kind === 'send')
        )

        if (item.kind === 'send') {
          await s.settleAttempt({
            kind: 'send',
            id: item.record.deliveryId,
            lease: item.lease,
            outcome: { status: 'sent', receipt: {} },
            now: 111,
            nextDueAt: 110
          })
        }
      }
      expect(await s.cleanup({ before: 110, limit: 10 })).toEqual({
        redacted: 0
      })
      expect(await s.cleanup({ before: 200, limit: 10 })).toEqual({
        redacted: 2
      })
      expect((await s.getInbound('r1'))?.snapshot).toMatchObject({
        text: '',
        context: null,
        attachments: []
      })
      expect(await s.acceptInbound(snapshot())).toEqual({
        requestId: 'r1',
        duplicate: true
      })
      expect(await s.enqueueMessage(first)).toMatchObject({
        status: 'queued',
        replay: true
      })
      expect(
        await s.enqueueMessage({
          ...first,
          message: { ...first.message, text: 'changed' }
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await s.enqueueMessage(completion('channel', 'new'))
      ).toMatchObject({ status: 'queued', replay: false })
    })

    it('rejects non-JSON snapshots and rolls back publication on malformed delivery serialization', async () => {
      await expect(
        s.acceptInbound({ ...snapshot(), context: { bad: undefined } as never })
      ).rejects.toThrow()
      expect(await s.getInbound('r1')).toBeUndefined()
      await s.acceptInbound(snapshot())
      const input = completion()
      await expect(
        s.enqueueMessage({
          ...input,
          outbound: {
            ...input.outbound,
            trace: { traceparent: undefined } as never
          }
        })
      ).rejects.toThrow()
      expect(await s.getOutbound(input.outbound.deliveryId)).toBeUndefined()
      expect(await s.enqueueMessage(input)).toMatchObject({ status: 'queued' })
    })

    it('fences stale state mutations across delete and recreate without hiding null values', async () => {
      const ns = { pluginId: 'dot', ownerId: 'ep' }

      const initial = await s.compareAndSetState(ns, {
        key: 'subscription',
        expectedVersion: null,
        value: 'old-secret'
      })

      expect(initial).toEqual({ status: 'updated', version: 1 })
      expect(await s.deleteState(ns, 'subscription', 1)).toEqual({
        status: 'updated',
        version: 2
      })
      expect(await s.getState(ns, 'subscription')).toBeUndefined()
      expect(await s.listState(ns, { limit: 10 })).toEqual([])
      expect(await s.deleteState(ns, 'subscription', 2)).toEqual({
        status: 'not_found'
      })
      expect(
        await s.compareAndSetState(ns, {
          key: 'subscription',
          expectedVersion: 2,
          value: 'stale'
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await s.compareAndSetState(ns, {
          key: 'subscription',
          expectedVersion: null,
          value: null
        })
      ).toEqual({ status: 'updated', version: 3 })
      expect(await s.deleteState(ns, 'subscription', 1)).toEqual({
        status: 'conflict'
      })
      expect(
        await s.compareAndSetState(ns, {
          key: 'subscription',
          expectedVersion: 1,
          value: 'stale'
        })
      ).toEqual({ status: 'conflict' })
      expect(await s.getState(ns, 'subscription')).toEqual({
        key: 'subscription',
        value: null,
        version: 3
      })
      expect(await s.listState(ns, { prefix: 'sub', limit: 10 })).toEqual([
        { key: 'subscription', value: null, version: 3 }
      ])
    })

    // Protect literal Unicode prefixes before SQL ordering/limits. ASCII wildcard coverage
    // Cannot catch passing UTF-16 lengths to a database that counts Unicode code points.
    // This exercises the public state API against each real database without a new seam.
    it('lists Unicode state prefixes literally before applying the result limit', async () => {
      const ns = { pluginId: 'channel', ownerId: 'account' }
      for (const key of [
        String.raw`🚀%_\a`,
        String.raw`🚀%_\b`,
        '🚀other',
        'other'
      ]) {
        await s.compareAndSetState(ns, {
          key,
          expectedVersion: null,
          value: key
        })
      }
      expect(await s.listState(ns, { prefix: '🚀%_\\', limit: 1 })).toEqual([
        { key: '🚀%_\\a', value: '🚀%_\\a', version: 1 }
      ])
      expect(await s.listState(ns, { prefix: '🚀%_\\', limit: 10 })).toEqual([
        { key: '🚀%_\\a', value: '🚀%_\\a', version: 1 },
        { key: '🚀%_\\b', value: '🚀%_\\b', version: 1 }
      ])
    })

    it('starts a fresh delivery retry budget on explicit recovery', async () => {
      await s.acceptInbound(snapshot())
      await dispatch()
      await s.enqueueMessage(completion())
      const first = required((await due(110))[0])
      await s.settleAttempt({
        kind: 'send',
        id: 'd-channel-message',
        lease: first.lease,
        outcome: { status: 'retryable', errorCode: 'rate_limit' },
        now: 111,
        nextDueAt: 112
      })
      const second = required((await due(112))[0])
      await s.settleAttempt({
        kind: 'send',
        id: 'd-channel-message',
        lease: second.lease,
        outcome: { status: 'rejected', errorCode: 'retry_budget_exhausted' },
        now: 113,
        nextDueAt: 113
      })
      const rejected = required(await s.getOutbound('d-channel-message'))
      expect(rejected.attempts).toBe(2)
      expect(
        await s.requeue({
          kind: 'delivery',
          id: 'd-channel-message',
          expectedVersion: rejected.version,
          now: 114,
          acknowledgeUnknown: false
        })
      ).toMatchObject({ status: 'updated' })
      expect(await s.getOutbound('d-channel-message')).toMatchObject({
        attempts: 0,
        currentChunk: 0,
        receipts: [],
        status: 'pending',
        chunks: [{ idempotencyKey: 'c1' }, { idempotencyKey: 'c2' }]
      })
      expect(await due(114)).toHaveLength(1)
    })

    it('applies endpoint, status and pagination filters to administrative message inspection', async () => {
      await s.acceptInbound(snapshot())
      await s.acceptInbound(snapshot('r2', 100, 'other'))

      const work = await due(100)
      for (const item of work) {
        if (item.kind === 'dispatch') {
          await s.settleAttempt({
            kind: 'dispatch',
            id: item.record.snapshot.requestId,
            lease: item.lease,
            outcome: { status: 'accepted' },
            now: 101,
            nextDueAt: 101
          })
        }
      }

      const first = completion()

      const second = {
        ...completion('other', 'message', 'other'),
        endpointIds: ['other']
      }

      await s.enqueueMessage(first)
      await s.enqueueMessage(second)
      expect(
        (
          await s.listInbound({
            endpointId: 'ep',
            dispatchStatus: 'accepted',
            limit: 10
          })
        ).map((record) => record.snapshot.requestId)
      ).toEqual(['r1'])
      expect(
        (
          await s.listInbound({
            dispatchStatus: 'accepted',
            afterId: 'r1',
            limit: 1
          })
        ).map((record) => record.snapshot.requestId)
      ).toEqual(['r2'])
      expect(
        (
          await s.listOutbound({
            endpointId: 'other',
            deliveryStatus: 'pending',
            limit: 10
          })
        ).map((record) => record.deliveryId)
      ).toEqual([second.outbound.deliveryId])
      expect(
        (
          await s.listOutbound({ afterId: first.outbound.deliveryId, limit: 1 })
        ).map((record) => record.deliveryId)
      ).toEqual([second.outbound.deliveryId])
      expect(await s.getStats()).toEqual({
        pending: 0,
        undelivered: 2,
        unknown: 0
      })
    })

    it('isolates durable protocol namespaces and enforces compare-and-set, expiry filters and literal prefixes', async () => {
      const ns = { pluginId: 'dot', ownerId: 'a' }
      expect(
        await s.compareAndSetState(ns, {
          key: 'cursor_1',
          expectedVersion: null,
          value: { v: 1 },
          expiresAt: 200
        })
      ).toEqual({ status: 'updated', version: 1 })
      expect(
        await s.compareAndSetState(ns, {
          key: 'cursor_1',
          expectedVersion: null,
          value: { v: 2 }
        })
      ).toEqual({ status: 'conflict' })
      expect(
        await s.getState({ ...ns, ownerId: 'b' }, 'cursor_1')
      ).toBeUndefined()
      await s.compareAndSetState(ns, {
        key: 'cursorX1',
        expectedVersion: null,
        value: 2
      })
      expect(
        (await s.listState(ns, { prefix: 'cursor_', limit: 10 })).map(
          (entry) => entry.key
        )
      ).toEqual(['cursor_1'])
      expect(await s.listState(ns, { expiresBefore: 199, limit: 10 })).toEqual(
        []
      )
      expect(
        await s.listState(ns, { expiresBefore: 201, limit: 10 })
      ).toHaveLength(1)
      expect(await s.deleteState(ns, 'cursor_1', 0)).toEqual({
        status: 'conflict'
      })
      expect(await s.deleteState(ns, 'cursor_1', 1)).toEqual({
        status: 'updated',
        version: 2
      })
    })
  })
}
