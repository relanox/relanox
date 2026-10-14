import process from 'node:process'
import type { ChannelHost, IngestInput } from '@relanox/sdk'
import { z } from 'zod'

export function secret(ref: { env: string }): string {
  const value = process.env[ref.env]
  if (!value) {
    throw new Error('missing_secret')
  }
  return value
}

/** Policy rejections discard input; other failures are reported without rewinding the SDK cursor. */
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
          'media_total_too_large',
          'too_many_attachments'
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
