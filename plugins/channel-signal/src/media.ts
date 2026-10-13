import { requestTimeoutMs } from './constants.js'
import { mediaKind } from '@relanox/channel-media'
import type { ChannelHost, MediaUpload, SendInput } from '@relanox/sdk'
import { z } from 'zod'
import type { attachmentSchema } from './schemas.js'
import type { SignalConfig } from './config.js'
import { readJson } from './protocol.js'

const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)

/** Known local byte policy; protocol, network and daemon errors stay replayable. */
export class SignalMediaPolicyError extends Error {
  constructor(readonly code: 'media_too_large' | 'media_response_too_large') {
    super(code)
    this.name = 'SignalMediaPolicyError'
  }
}

export async function receiveAttachments(
  attachments: readonly z.infer<typeof attachmentSchema>[],
  host: ChannelHost,
  config: SignalConfig,
  base: string,
  headers: Readonly<Record<string, string>>,
  sender: string,
  groupId: string | undefined,
  signal: AbortSignal
): Promise<MediaUpload[]> {
  const result: MediaUpload[] = []
  const maximum = host.maxMediaBytes ?? 16_777_216
  for (const attachment of attachments) {
    if (!attachment.id) {
      throw new Error('media_unavailable')
    }
    if (
      attachment.size !== undefined &&
      attachment.size !== null &&
      attachment.size > maximum
    ) {
      throw new SignalMediaPolicyError('media_too_large')
    }
    const id = crypto.randomUUID()

    const response = await fetch(`${base}/api/v1/rpc`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'getAttachment',
        params: {
          account: config.account,
          id: attachment.id,
          ...(groupId ? { groupId } : { recipient: sender })
        }
      })
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('media_download_failed')
    }
    const encodedMaximum = Math.ceil(maximum / 3) * 4

    const rpc = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.literal(id),
        result: z.object({ data: base64Schema })
      })
      .parse(
        await readJson(
          response,
          encodedMaximum + 16_384,
          new SignalMediaPolicyError('media_response_too_large')
        )
      )

    if (rpc.result.data.length > encodedMaximum) {
      throw new SignalMediaPolicyError('media_too_large')
    }

    const data = new Uint8Array(Buffer.from(rpc.result.data, 'base64'))
    if (data.byteLength === 0 || data.byteLength > maximum) {
      throw new SignalMediaPolicyError('media_too_large')
    }

    const mimeType =
      attachment.contentType.split(';')[0]?.trim().toLowerCase() ?? ''

    result.push({
      kind: mediaKind(mimeType),
      mimeType,
      fileName: attachment.filename ?? 'attachment.bin',
      data
    })
  }
  return result
}

export function outboundAttachments(
  input: SendInput
): Record<string, readonly string[]> {
  if (!input.media) {
    return {}
  }
  const media = input.media
  return {
    attachments: [
      `data:${media.reference.mimeType};filename=${encodeURIComponent(media.reference.fileName)};base64,${Buffer.from(media.data).toString('base64')}`
    ]
  }
}
