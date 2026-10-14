import { expect, it } from 'vitest'
import { incoming, mediaFixture, picture } from './fixture.js'
import { required } from '../contracts/storage-contract.js'

it('keeps a text and image final pending until every chunk succeeds and replays it after restart and cleanup', async () => {
  const fx = await mediaFixture()
  try {
    const receipt = await fx.channel.ingest({ ...incoming, text: 'question' })

    const principal = (): ReturnType<typeof fx.agent.forPrincipal> =>
      fx.agent.forPrincipal({ subject: 'agent', endpointIds: ['first'] })

    const status = async (): Promise<unknown> =>
      (await principal().status({ requestId: receipt.requestId })).request
        ?.reply

    await fx.runtime.processDue()
    expect(await status()).toEqual({ status: 'awaiting_final' })
    await principal().readMessages({ requestId: receipt.requestId })

    const progress = await principal().sendMessage({
      channel: fx.channelId,
      text: '...',
      reply: { requestId: receipt.requestId, kind: 'progress' }
    })

    expect(progress.status).toBe('queued')
    await fx.runtime.processDue()
    expect(await status()).toEqual({ status: 'awaiting_final' })

    const input = {
      channel: fx.channelId,
      text: 'abc',
      attachments: [picture],
      reply: { requestId: receipt.requestId, kind: 'final' as const }
    }

    const final = await principal().sendMessage(input)
    if (final.status !== 'queued') {
      throw new Error('Missing delivery')
    }
    expect(await status()).toEqual({
      status: 'pending',
      deliveryId: final.deliveryId
    })
    expect(
      await principal().sendMessage({
        ...input,
        idempotencyKey: 'different-key'
      })
    ).toEqual({ ...final, replay: true })
    expect(await principal().sendMessage({ ...input, text: 'xyz' })).toEqual({
      status: 'conflict'
    })

    const firstPart = required(
      (
        await fx.storage.takeDue({
          now: Date.now(),
          leaseMs: 10_000,
          limit: 1,
          leaseOwner: 'test',
          safeRetryAccountIds: []
        })
      )[0]
    )

    expect(firstPart.kind).toBe('send')
    await fx.storage.settleAttempt({
      kind: 'send',
      id: final.deliveryId,
      lease: firstPart.lease,
      now: Date.now(),
      nextDueAt: Date.now(),
      outcome: {
        status: 'sent',
        receipt: { platformMessageId: 'text-receipt' }
      }
    })
    expect(await status()).toEqual({
      status: 'pending',
      deliveryId: final.deliveryId
    })

    // The final image has not been sent. A permanent failure must not complete the request.
    const work = required(
      (
        await fx.storage.takeDue({
          now: Date.now(),
          leaseMs: 10_000,
          limit: 1,
          leaseOwner: 'test',
          safeRetryAccountIds: []
        })
      )[0]
    )

    expect(work.kind).toBe('send')
    await fx.storage.settleAttempt({
      kind: 'send',
      id: final.deliveryId,
      lease: work.lease,
      now: Date.now(),
      nextDueAt: Date.now(),
      outcome: { status: 'rejected', errorCode: 'media_rejected' }
    })
    expect(await status()).toEqual({
      status: 'rejected',
      deliveryId: final.deliveryId,
      errorCode: 'media_rejected'
    })
    const runtime = await fx.restart()
    const stored = required(await fx.storage.getOutbound(final.deliveryId))
    expect(stored.currentChunk).toBe(1)
    expect(stored.receipts).toEqual([{ platformMessageId: 'text-receipt' }])
    await fx.storage.requeue({
      kind: 'delivery',
      id: final.deliveryId,
      expectedVersion: stored.version,
      now: Date.now(),
      acknowledgeUnknown: false
    })
    await runtime.processDue()
    expect(await status()).toEqual({
      status: 'sent',
      deliveryId: final.deliveryId
    })
    expect(
      fx.sent.map((part) =>
        part.media ? part.media.reference.kind : part.chunk.text
      )
    ).toEqual(['...', 'image'])
    await fx.storage.cleanup({ before: Date.now() + 1000, limit: 20 })
    expect(await principal().sendMessage(input)).toEqual({
      ...final,
      replay: true
    })
    expect(await status()).toEqual({
      status: 'sent',
      deliveryId: final.deliveryId
    })
    expect(
      (
        await fx.agent
          .forPrincipal({ subject: 'other', endpointIds: ['other'] })
          .status({ requestId: receipt.requestId })
      ).request
    ).toBeUndefined()
  } finally {
    await fx.close()
  }
})

it('recovers unanswered content after restart and explicitly reports expiry after retention', async () => {
  const fx = await mediaFixture()
  try {
    const input = await fx.channel.ingest({
      ...incoming,
      text: 'recover me',
      attachments: [picture]
    })

    await fx.runtime.processDue()
    await fx.restart()

    const principal = fx.agent.forPrincipal({
      subject: 'agent',
      endpointIds: ['first']
    })

    const pending = await principal.readMessages({ pending: true })
    expect(pending).toMatchObject([
      {
        requestId: input.requestId,
        text: 'recover me',
        attachments: [{ kind: 'image' }],
        reply: { status: 'awaiting_final' }
      }
    ])
    expect(await principal.readMessages({ pending: true })).toEqual(pending)
    expect(await fx.storage.listOutbound({ limit: 20 })).toEqual([])
    expect(
      await fx.agent
        .forPrincipal({ subject: 'other', endpointIds: ['other'] })
        .readMessages({ pending: true })
    ).toEqual([])
    await fx.storage.cleanup({ before: Date.now() + 1000, limit: 20 })
    expect(await principal.readMessages({ pending: true })).toEqual([])
    expect(
      (await principal.status({ requestId: input.requestId })).request?.reply
    ).toEqual({ status: 'expired' })
    expect(
      await principal.sendMessage({
        channel: fx.channelId,
        text: 'late answer',
        reply: { requestId: input.requestId, kind: 'final' }
      })
    ).toEqual({ status: 'not_found' })
  } finally {
    await fx.close()
  }
})
