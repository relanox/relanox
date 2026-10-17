import type { ChannelHost, IngestInput, SendResult } from '@relanox/sdk'
import { z } from 'zod'
import { RemoteError } from './remote-error.js'

export { RemoteError } from './remote-error.js'

export function secret(ref: { env: string }): string {
  const value = process.env[ref.env]
  if (!value) {
    throw new Error('missing_secret')
  }
  return value
}

/** Policy rejections discard input; storage/unknown failures must remain unacknowledged. */
export async function ingestText(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const rejection = z
      .object({
        code: z.enum([
          'sender_not_allowed',
          'unbound_conversation',
          'too_many_attachments',
          'media_total_too_large'
        ])
      })
      .safeParse(error)

    if (!rejection.success) {
      throw error
    }
    host.observe.log('info', 'channel_input_discarded', {
      errorCode: rejection.data.code
    })
  }
}

/** Narrow fallback for the legacy multipart endpoint absent from the generated SDK. */
export async function uploadJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  })

  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'))
    throw new RemoteError({
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs:
        Number.isFinite(retry) && retry > 0
          ? Math.min(retry * 1000, 300_000)
          : 1000
    })
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('missing_response_body')
  }
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) {
      break
    }
    size += part.value.byteLength
    if (size > 1024 * 1024) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    parts.push(part.value)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    if (response.ok) {
      throw new Error('invalid_response_json')
    }
  }
  if (!response.ok) {
    throw new RemoteError(
      {
        status: response.status >= 500 ? 'unknown' : 'rejected',
        errorCode: `http_${response.status}`
      },
      body
    )
  }
  return body
}

/** Preserve Core's outcome classification; the SDK does not retry message POSTs. */
export function sendFailure(error: unknown): SendResult {
  if (error instanceof RemoteError) {
    return error.result
  }
  const remote = z.object({ statusCode: z.number() }).safeParse(error)
  if (!remote.success) {
    return { status: 'unknown', errorCode: 'transport_uncertain' }
  }
  const status = remote.data.statusCode
  if (status === 429) {
    // The official DingTalk gateway exposes status/body but drops response headers.
    return {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: 1000
    }
  }
  if (status === 401) {
    return {
      status: 'retryable',
      errorCode: 'token_expired',
      retryAfterMs: 1000
    }
  }
  return {
    status: status >= 500 ? 'unknown' : 'rejected',
    errorCode: `http_${status}`
  }
}
