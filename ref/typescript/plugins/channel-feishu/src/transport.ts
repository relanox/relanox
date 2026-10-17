import { readBounded } from '@relanox/transport'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ChannelHost, IngestInput, SecretRef } from '@relanox/sdk'
import { z } from 'zod'

export function credential(
  ref: SecretRef,
  environment: NodeJS.ProcessEnv
): string {
  const value = environment[ref.env]
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error('missing_or_invalid_credential')
  }
  return value
}

export function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest()
  )
}

export async function bytes(
  request: Request,
  max = 1024 * 1024
): Promise<Buffer> {
  return readBounded(request.body, max)
}

export function fresh(value: string | null): boolean {
  return (
    value !== null &&
    /^\d+$/u.test(value) &&
    Math.abs(Date.now() - Number(value) * 1000) <= 300_000
  )
}

/** Policy exclusions are terminal; storage and unexpected failures must remain unacknowledged. */
export async function ingest(
  host: ChannelHost,
  input: IngestInput
): Promise<void> {
  try {
    await host.ingest(input)
  } catch (error) {
    const parsed = z.object({ code: z.string() }).safeParse(error)
    if (
      !parsed.success ||
      ![
        'sender_not_allowed',
        'unbound_conversation',
        'too_many_attachments',
        'media_total_too_large'
      ].includes(parsed.data.code)
    ) {
      throw error
    }
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: parsed.data.code
    })
  }
}
