import { setTimeout as pause } from 'node:timers/promises'
import type {
  ChannelHost,
  IngestInput,
  SendResult,
  SecretRef
} from '@relanox/sdk'
import { z } from 'zod'

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

export function httpFailure(response: Response): SendResult {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'))

    const retryAfterMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000

    return { status: 'retryable', errorCode: 'rate_limited', retryAfterMs }
  }
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
