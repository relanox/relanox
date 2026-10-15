import { expect, it } from 'vitest'
import { setTimeout as pause } from 'node:timers/promises'
import { z } from 'zod'
import { createMatrixChannel } from '../src/index.js'
import { body, harness, httpPeer, json, waitFor } from './harness.js'

const room = '!modern:example.org'
const thread = '$modern-thread'
const sender = '@alice:example.org'

function textEvent(
  eventId: string,
  relation?: Record<string, unknown>
): unknown {
  return {
    event_id: eventId,
    sender,
    type: 'm.room.message',
    origin_server_ts: 1_800_000_000_000,
    content: {
      msgtype: 'm.text',
      body: eventId,
      ...(relation?.rel_type === 'm.replace'
        ? { 'm.new_content': { msgtype: 'm.text', body: 'edited room' } }
        : {}),
      ...(relation ? { 'm.relates_to': relation } : {})
    }
  }
}

// Protect per-account routing, frozen reply targets and transaction identity.
// SDK 43.0.0 Thread.setServerSideSupport latches a process-global thread name;
// Starting a v1.3 peer must not discard another account's m.thread events or
// Change its outbound relation. Existing peers all advertise v1.4. Real SDK
// Bootstrap, HTTP and Core/SQLite exercise both orders without a production seam.
// Wire fields: SDK src/client.ts:addThreadRelationIfNeeded and
// https://spec.matrix.org/v1.16/client-server-api/#threading
// https://spec.matrix.org/v1.16/client-server-api/#rate-limiting
it.each(['modern first', 'legacy first'] as const)(
  'isolates native Matrix threads across accounts started %s',
  async (order) => {
    let stage = 0
    let deliveredStage = 0
    let ordinaryAttempts = 0
    const syncTokens: (string | undefined)[] = []

    const sent: {
      path: string
      method: string | undefined
      authorization: string | undefined
      data: Record<string, unknown>
    }[] = []

    const modernPeer = await httpPeer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://peer').pathname
      if (path.endsWith('/sync')) {
        await pause(20)
        syncTokens.push(request.headers.authorization)
        let events: unknown[] = []
        if (stage > deliveredStage) {
          deliveredStage = stage
          events =
            stage === 1
              ? [
                  textEvent('$original', {
                    rel_type: 'm.thread',
                    event_id: thread
                  }),
                  textEvent('$unstable', {
                    rel_type: 'io.element.thread',
                    event_id: thread
                  }),
                  textEvent('$room'),
                  textEvent('$room-reply', {
                    'm.in_reply_to': { event_id: '$room' }
                  }),
                  textEvent('$edit', {
                    rel_type: 'm.replace',
                    event_id: '$room'
                  })
                ]
              : [
                  textEvent('$later', {
                    rel_type: 'm.thread',
                    event_id: thread
                  })
                ]
        }
        json(response, {
          next_batch: `modern-${deliveredStage}`,
          rooms: { join: { [room]: { timeline: { events } } } }
        })
        return
      }
      if (path.includes('/state/m.room.encryption')) {
        json(response, { errcode: 'M_NOT_FOUND' }, 404)
        return
      }
      if (path.includes('/send/')) {
        const data = z
          .record(z.string(), z.unknown())
          .parse(await body(request))

        sent.push({
          path,
          method: request.method,
          authorization: request.headers.authorization,
          data
        })
        if (data.body === 'ordinary answer' && ordinaryAttempts++ === 0) {
          json(
            response,
            { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 },
            429
          )
        } else {
          json(response, { event_id: '$native-reply' })
        }
        return
      }
      await body(request)
      json(response, {})
    })

    const legacyPeer = await httpPeer(
      async (_request, response) => {
        await pause(20)
        json(response, { next_batch: 'legacy', rooms: {} })
      },
      (_request, response) => {
        json(response, { user_id: '@legacy-bot:example.org' })
      },
      (response) => {
        json(response, { versions: ['v1.3'], unstable_features: {} })
      }
    )

    const modern = createMatrixChannel({ MATRIX_TOKEN: 'modern-token' })
    const legacy = createMatrixChannel({ MATRIX_TOKEN: 'legacy-token' })

    const fixture = await harness(
      modern,
      {
        homeserver: modernPeer.base,
        accessToken: { env: 'MATRIX_TOKEN' },
        allowInsecureLocalhost: true
      },
      [{ chatId: room }, { chatId: room, threadId: thread }],
      [sender],
      `${modernPeer.base}/dispatch`,
      {
        accounts: [
          {
            id: 'legacy',
            plugin: legacy,
            config: {
              homeserver: legacyPeer.base,
              accessToken: { env: 'MATRIX_TOKEN' },
              allowInsecureLocalhost: true
            },
            chats: [{ chatId: '!legacy:example.org' }],
            senders: [sender]
          }
        ]
      }
    )

    const channels =
      order === 'legacy first' ? [legacy, modern] : [modern, legacy]

    for (const channel of channels) {
      await channel.start?.(new AbortController().signal)
    }
    stage = 1
    await waitFor(
      async () =>
        (await fixture.storage.listInbound({ limit: 10 })).length === 4
    )
    const records = await fixture.storage.listInbound({ limit: 10 })

    const original = records.find(
      (record) => record.snapshot.source.eventId === '$original'
    )

    const roomInput = records.find(
      (record) => record.snapshot.source.eventId === '$room'
    )

    if (!original || !roomInput) {
      throw new Error('Missing modern thread input')
    }
    expect(
      records.map((record) => ({
        eventId: record.snapshot.source.eventId,
        accountId: record.snapshot.target.accountId,
        threadId: record.snapshot.target.threadId ?? null
      }))
    ).toEqual(
      expect.arrayContaining([
        { eventId: '$original', accountId: 'bot', threadId: thread },
        { eventId: '$unstable', accountId: 'bot', threadId: thread },
        { eventId: '$room', accountId: 'bot', threadId: null },
        { eventId: '$room-reply', accountId: 'bot', threadId: null }
      ])
    )
    expect(syncTokens).toContain('Bearer modern-token')
    await fixture.runtime.processDue()

    stage = 2
    await waitFor(
      async () =>
        (await fixture.storage.listInbound({ limit: 10 })).length === 5
    )
    await Promise.all([modern.stop?.(), legacy.stop?.()])

    const ordinary = await fixture.sendReply(
      original.snapshot.requestId,
      'ordinary answer'
    )

    const quoted = await fixture.sendReply(
      original.snapshot.requestId,
      'quoted answer',
      'final'
    )

    const roomQuoted = await fixture.sendReply(
      roomInput.snapshot.requestId,
      'room quoted answer',
      'final'
    )

    expect(
      (await fixture.storage.getOutbound(quoted.deliveryId))?.target
    ).toMatchObject({
      accountId: 'bot',
      chatId: room,
      threadId: thread,
      replyToId: '$original',
      data: { homeserver: modernPeer.base, userId: '@bot:local.test' }
    })
    await waitFor(async () => {
      await fixture.runtime.processDue()
      return (
        (await fixture.storage.getOutbound(ordinary.deliveryId))?.status ===
        'sent'
      )
    })
    expect((await fixture.storage.getOutbound(quoted.deliveryId))?.status).toBe(
      'sent'
    )
    expect(
      (await fixture.storage.getOutbound(roomQuoted.deliveryId))?.status
    ).toBe('sent')

    const expected = [
      {
        text: 'ordinary answer',
        deliveryId: ordinary.deliveryId,
        count: 2,
        relation: {
          rel_type: 'm.thread',
          event_id: thread,
          is_falling_back: true
        }
      },
      {
        text: 'quoted answer',
        deliveryId: quoted.deliveryId,
        count: 1,
        relation: {
          rel_type: 'm.thread',
          event_id: thread,
          is_falling_back: false,
          'm.in_reply_to': { event_id: '$original' }
        }
      },
      {
        text: 'room quoted answer',
        deliveryId: roomQuoted.deliveryId,
        count: 1,
        relation: {
          'm.in_reply_to': { event_id: '$room' }
        }
      }
    ]

    for (const message of expected) {
      const attempts = sent.filter((entry) => entry.data.body === message.text)
      expect(attempts).toHaveLength(message.count)
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          path: `/_matrix/client/v3/rooms/!modern%3Aexample.org/send/m.room.message/${encodeURIComponent(`${message.deliveryId}:0`)}`,
          method: 'PUT',
          authorization: 'Bearer modern-token',
          data: { 'm.relates_to': message.relation }
        })
      }
    }
  }
)
