/** Bounded streaming SSE decoder. Frames are committed only after the consumer resolves. */
export async function consumeEvents(
  response: Response,
  consume: (data: string, id: string | undefined) => Promise<void>
): Promise<void> {
  if (!response.body) {
    throw new Error('missing_event_stream')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let id: string | undefined
  let event = ''
  let size = 0

  async function line(value: string): Promise<void> {
    if (value === '') {
      if (data.length > 0 && (!event || event === 'receive')) {
        await consume(data.join('\n'), id)
      }
      data = []
      id = undefined
      event = ''
      size = 0
      return
    }
    size += value.length
    if (size > 1_048_576) {
      throw new Error('event_too_large')
    }
    const colon = value.indexOf(':')
    const key = colon === -1 ? value : value.slice(0, colon)

    const content =
      colon === -1 ? '' : value.slice(colon + 1).replace(/^ /u, '')

    if (key === 'data') {
      data.push(content)
    }
    if (key === 'event') {
      event = content
    }
    if (key === 'id' && !/[\0\r\n]/u.test(content)) {
      id = content
    }
  }

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        return
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > 1_048_576) {
        throw new Error('event_too_large')
      }
      for (;;) {
        const match = /\r\n|\r|\n/u.exec(buffer)
        if (
          !match ||
          (match[0] === '\r' && match.index === buffer.length - 1)
        ) {
          break
        }
        const value = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        await line(value)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
