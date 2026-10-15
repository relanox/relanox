export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max = 1024 * 1024
): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        return Buffer.concat(chunks)
      }
      total += next.value.byteLength
      if (total > max) {
        throw new Error('payload_too_large')
      }
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
}

export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error('empty_response')
  }
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > 2 * 1024 * 1024) {
        throw new Error('response_too_large')
      }
      pieces.push(value)
    }
    return JSON.parse(Buffer.concat(pieces).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
