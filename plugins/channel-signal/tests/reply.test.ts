import { expect, it } from 'vitest'
import { z } from 'zod'
import { assemble, records } from '../../channel-wecom/tests/test-support.js'
import {
  body,
  httpPeer,
  json,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createSignalChannel } from '../src/index.js'

// Verified signal-cli send JSON-RPC and receive contracts:
// https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc#send
// https://github.com/AsamK/signal-cli/blob/master/client/src/jsonrpc.rs
// Protects exact original sender/message timestamp/text across Core resolution.
// Timestamp substitution or quoting latest input fails native RPC assertions;
// Existing send/style/media tests do not request quotes through AgentHost.
// Real SQLite and HTTP/SSE peers require no added production testing seam.
it('quotes selected SSE requests out of order and omits quote fields on ordinary sends', async () => {
  const sent: unknown[] = []

  const remote = await httpPeer(async (request, response) => {
    if (request.url?.startsWith('/api/v1/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const id of [11, 22, 33]) {
        response.write(
          `id: event-${id}\ndata: ${JSON.stringify({
            account: '+10000000001',
            envelope: {
              sourceUuid: 'alice',
              timestamp: 1_800_000_001_000 + id,
              dataMessage: {
                timestamp: 1_800_000_000_000 + id,
                message: `question ${id}`
              }
            }
          })}\n\n`
        )
      }
      return
    }

    const rpc = z
      .object({ id: z.string(), params: z.unknown() })
      .parse(await body(request))

    sent.push(rpc.params)
    json(response, {
      jsonrpc: '2.0',
      id: rpc.id,
      result: { timestamp: 1_800_000_002_000 }
    })
  })

  const plugin = createSignalChannel()

  const fixture = await assemble(
    plugin,
    {
      serviceUrl: remote.base,
      account: '+10000000001',
      allowInsecureLocalhost: true
    },
    [{ chatId: 'direct:alice', senderId: 'alice' }]
  )

  await fixture.start()
  await waitFor(async () => (await records(fixture.storage)).length === 3)
  await plugin.stop?.()
  const received = await records(fixture.storage)
  for (const id of [22, 11, 33]) {
    const request = received.find(
      (item) => item.snapshot.text === `question ${id}`
    )

    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fixture.principal().sendMessage({
        channel: request.snapshot.channel.id,
        text: `answer ${id}`,
        reply: { requestId: request.snapshot.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await fixture.runtime.processDue()
  }
  const channel = received[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await fixture.principal().sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await fixture.runtime.processDue()
  expect(sent).toEqual([
    {
      account: '+10000000001',
      recipient: ['alice'],
      message: 'answer 22',
      quoteTimestamp: 1_800_000_000_022,
      quoteAuthor: 'alice',
      quoteMessage: 'question 22'
    },
    {
      account: '+10000000001',
      recipient: ['alice'],
      message: 'answer 11',
      quoteTimestamp: 1_800_000_000_011,
      quoteAuthor: 'alice',
      quoteMessage: 'question 11'
    },
    {
      account: '+10000000001',
      recipient: ['alice'],
      message: 'answer 33',
      quoteTimestamp: 1_800_000_000_033,
      quoteAuthor: 'alice',
      quoteMessage: 'question 33'
    },
    { account: '+10000000001', recipient: ['alice'], message: 'ordinary' }
  ])
})
