import { setTimeout as pause } from 'node:timers/promises'
import type {
  ChannelHost,
  IngestInput,
  SendResult,
  SecretRef
} from '@relanox/sdk'
import { z } from 'zod'
import { readJson } from '@relanox/transport'

export function secret(
  ref: SecretRef,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const value = environment[ref.env]
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error('invalid_secret')
  }
  return value
}

export { readJson } from '@relanox/transport'

export function diagnose(host: ChannelHost, errorCode: string): void {
  host.observe.log('warn', 'operation.failed', {
    operation: 'receive',
    errorCode
  })
  if (errorCode.endsWith('_unsupported')) {
    host.observe.count('relanox_inbound_total', {
      outcome: 'rejected',
      error_class: 'unsupported'
    })
  }
}

export async function ingest(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const code = z
      .object({
        code: z.enum([
          'sender_not_allowed',
          'unbound_conversation',
          'media_total_too_large'
        ])
      })
      .safeParse(error)

    if (!code.success) {
      throw error
    }
    diagnose(host, code.data.code)
  }
}

function headerRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }
  if (/^\d+$/u.test(value)) {
    const milliseconds = Number(value) * 1000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  }
  const date = new Date(value)
  return date.toUTCString() === value
    ? Math.max(0, date.getTime() - Date.now())
    : undefined
}

async function rateLimitDelay(response: Response): Promise<number> {
  const header = headerRetryAfter(response.headers.get('retry-after'))
  if (header !== undefined) {
    await response.body?.cancel()
    return header
  }
  try {
    const error = z
      .object({
        errcode: z.literal('M_LIMIT_EXCEEDED'),
        retry_after_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      })
      .safeParse(await readJson(response))

    return error.success ? error.data.retry_after_ms : 1000
  } catch {
    // HTTP 429 proves refusal even if its optional retry metadata is unavailable.
    return 1000
  }
}

export async function httpFailure(response: Response): Promise<SendResult> {
  if (response.status === 429) {
    return {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: await rateLimitDelay(response)
    }
  }
  await response.body?.cancel()
  if (response.status >= 400 && response.status < 500) {
    return { status: 'rejected', errorCode: 'platform_rejected' }
  }
  return { status: 'unknown', errorCode: 'platform_response_unknown' }
}

export async function delay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  await pause(milliseconds, undefined, { signal }).catch(() => {})
}

export async function stopTask(task: Promise<void> | undefined): Promise<void> {
  if (!task) {
    return
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}
