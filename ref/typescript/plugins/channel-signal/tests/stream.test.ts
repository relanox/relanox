import { expect, it } from 'vitest'
import { consumeEvents } from '../src/stream.js'

// SSE framing: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
// Protect arbitrary transport chunking, complete-event bounds and ordered delivery.
// A coalesced chunk previously hit the partial-event limit before decoding any events;
// Existing HTTP fixtures contain only small frames and cannot select Fetch chunk sizes.
// The existing production decoder boundary requires no additional testing seam.
function response(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      }
    })
  )
}

it('accepts coalesced events larger than the limit on one unfinished event', async () => {
  const payload = 'x'.repeat(600_000)
  const events: { data: string; id: string | undefined }[] = []
  await consumeEvents(
    response([
      `id: first\ndata: ${payload}\n\nid: second\ndata: ${payload}\n\n`
    ]),
    async (data, id) => {
      events.push({ data, id })
    }
  )
  expect(events).toEqual([
    { data: payload, id: 'first' },
    { data: payload, id: 'second' }
  ])
})

it('decodes split CRLF and data lines while ignoring comments and other event types', async () => {
  const events: { data: string; id: string | undefined }[] = []
  await consumeEvents(
    response([
      ': heartbeat\r',
      '\nid: first\r\nevent: receive\r\ndata: first\r',
      '\ndata: second\r\n\r',
      '\nevent: ignored\ndata: ignored\n\ndata: final\n\n'
    ]),
    async (data, id) => {
      events.push({ data, id })
    }
  )
  expect(events).toEqual([
    { data: 'first\nsecond', id: 'first' },
    { data: 'final', id: undefined }
  ])
})

it('does not deliver an incomplete event at EOF', async () => {
  const events: string[] = []
  await consumeEvents(
    response(['data: committed\n\ndata: incomplete']),
    async (data) => {
      events.push(data)
    }
  )
  expect(events).toEqual(['committed'])
})

it('does not consume later frames after the consumer fails', async () => {
  const events: string[] = []
  await expect(
    consumeEvents(
      response(['data: first\n\ndata: second\n\n']),
      async (data) => {
        events.push(data)
        throw new Error('storage_unavailable')
      }
    )
  ).rejects.toThrow('storage_unavailable')
  expect(events).toEqual(['first'])
})

it.each([
  ['data: ', 'x'.repeat(1024 * 1024 + 1)],
  [`data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`, ''],
  [`data: ${'x'.repeat(600_000)}\n`, `data: ${'x'.repeat(600_000)}\n`]
])('rejects an oversized unfinished event', async (...chunks) => {
  const events: string[] = []
  await expect(
    consumeEvents(response(chunks), async (data) => {
      events.push(data)
    })
  ).rejects.toThrow()
  expect(events).toEqual([])
})
