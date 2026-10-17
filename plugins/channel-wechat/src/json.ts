/** Bound JSON responses and retain native uint64 message identifiers exactly. */
export async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('wechat_empty_response')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) {
        break
      }
      size += part.value.byteLength
      if (size > 4 * 1024 * 1024) {
        throw new Error('wechat_response_too_large')
      }
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return JSON.parse(
    Buffer.concat(chunks, size).toString('utf8'),
    (key: string, value: unknown, context?: { source?: string }): unknown => {
      if (
        key === 'message_id' &&
        typeof value === 'number' &&
        context?.source &&
        /^\d+$/u.test(context.source)
      ) {
        return context.source
      }
      return value
    }
  ) as unknown
}
