import type { ChannelHost, IngestInput } from '@relanox/sdk'
import type { RawData } from 'ws'
import { z } from 'zod'

export function wireText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8')
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  return Buffer.from(data).toString('utf8')
}

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
): Promise<boolean> {
  try {
    await host.ingest(input)
    return true
  } catch (error) {
    const rejection = z
      .object({
        code: z.enum([
          'sender_not_allowed',
          'unbound_conversation',
          'media_too_large',
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
    return false
  }
}
