import { EventSourceParserStream } from 'eventsource-parser/stream'

const maxEventSize = 1024 * 1024

/** Bounded streaming SSE decoder. Frames are committed only after the consumer resolves. */
export async function consumeEvents(
  response: Response,
  consume: (data: string, id: string | undefined) => Promise<void>
): Promise<void> {
  if (!response.body) {
    throw new Error('missing_event_stream')
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: maxEventSize }))
    .getReader()

  try {
    for (;;) {
      const frame = await reader.read()
      if (frame.done) {
        return
      }
      // The parser's buffer limit covers partial events. Complete events in a
      // Single transport chunk also need the same per-event bound.
      if (frame.value.data.length > maxEventSize) {
        throw new Error('event_too_large')
      }
      if (!frame.value.event || frame.value.event === 'receive') {
        await consume(frame.value.data, frame.value.id)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
