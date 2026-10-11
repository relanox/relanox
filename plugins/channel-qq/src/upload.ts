import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import type { SendInput, SendResult } from '@relanox/sdk'
import { z } from 'zod'
import { apiError } from './api-error.js'
import { validateTransportUrl } from './config.js'
import type { QqConfig } from './config.js'
import { httpJson, jsonPostRequest, RemoteError } from './transport.js'

const byteCount = z
  .string()
  .regex(/^[0-9]+$/u)
  .transform(Number)
  .pipe(z.number().int().positive().max(209_715_200))

const preparedSchema = z.object({
  upload_id: z.string().min(1).max(1024),
  block_size: byteCount,
  parts: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        presigned_url: z.url(),
        block_size: byteCount
      })
    )
    .min(1)
    .max(10_000)
})

const formats: Readonly<Record<string, readonly string[]>> = {
  image: ['image/png', 'image/jpeg'],
  audio: ['audio/silk', 'audio/x-silk'],
  video: ['video/mp4']
}

const digest = (algorithm: string, bytes: Uint8Array) =>
  createHash(algorithm).update(bytes).digest('hex')

async function apiRequest(
  url: string,
  body: unknown,
  credential: string,
  signal: AbortSignal
) {
  const raw = await httpJson(
    url,
    jsonPostRequest(body, { Authorization: `QQBot ${credential}` }),
    signal
  )

  const failure = apiError(raw, true)
  if (failure) {
    throw new RemoteError(failure, raw)
  }
  return raw
}

function validateParts(
  prepared: z.infer<typeof preparedSchema>,
  size: number,
  config: QqConfig
) {
  const parts = prepared.parts.toSorted(
    (left, right) => left.index - right.index
  )

  if (parts.length !== Math.ceil(size / prepared.block_size)) {
    throw new Error('invalid_upload_parts')
  }
  return parts.map((part, index) => {
    const offset = index * prepared.block_size
    if (
      part.index !== index ||
      part.block_size !== Math.min(prepared.block_size, size - offset)
    ) {
      throw new Error('invalid_upload_part_size')
    }
    const url = new URL(part.presigned_url)

    const allowLoopback =
      config.allowInsecureLoopback &&
      url.origin === new URL(config.apiBase).origin

    return {
      index,
      block_size: part.block_size,
      offset,
      url: validateTransportUrl(url.href, false, allowLoopback)
    }
  })
}

async function putPart(
  url: string,
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<void> {
  // The signed URL supplies its own authorization. Never forward the QQBot credential.
  const response = await fetch(url, {
    method: 'PUT',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(bytes)])
  })

  await response.body?.cancel()
  if (!response.ok) {
    throw new RemoteError({
      status: 'retryable',
      errorCode: 'media_part_upload_failed'
    })
  }
}

export async function uploadMedia(
  input: SendInput,
  type: 'group' | 'c2c',
  credential: string,
  config: QqConfig
): Promise<string | SendResult | undefined> {
  if (!input.chunk.media) {
    return undefined
  }
  if (!input.media) {
    return { status: 'rejected', errorCode: 'missing_media' }
  }
  const { kind, mimeType, fileName } = input.media.reference
  if (kind !== 'file' && !formats[kind]?.includes(mimeType)) {
    return { status: 'rejected', errorCode: 'unsupported_media_format' }
  }
  const bytes = input.media.data
  if (bytes.byteLength > 200_000_000) {
    return { status: 'rejected', errorCode: 'unsupported_media_size' }
  }
  const base = `${config.apiBase.replace(/\/$/u, '')}/v2/${type === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(input.target.chatId)}`
  const fileType = { image: 1, video: 2, audio: 3, file: 4 }[kind]
  const md5 = digest('md5', bytes)

  const prepared = preparedSchema.parse(
    await apiRequest(
      `${base}/upload_prepare`,
      {
        file_type: fileType,
        file_size: String(bytes.byteLength),
        file_name: fileName,
        md5,
        sha1: digest('sha1', bytes),
        md5_10m:
          bytes.byteLength <= 10_002_432
            ? md5
            : digest('md5', bytes.subarray(0, 10_002_432))
      },
      credential,
      input.signal
    )
  )

  const parts = validateParts(prepared, bytes.byteLength, config)
  for (const part of parts) {
    if (part.index > 0) {
      // The native part confirmation endpoint is limited to ten requests per second.
      await pause(110, undefined, { signal: input.signal })
    }
    const data = bytes.subarray(part.offset, part.offset + part.block_size)
    await putPart(part.url, data, input.signal)
    await apiRequest(
      `${base}/upload_part_finish`,
      {
        upload_id: prepared.upload_id,
        part_index: part.index,
        block_size: String(data.byteLength),
        md5: digest('md5', data)
      },
      credential,
      input.signal
    )
  }

  const response = await apiRequest(
    `${base}/files`,
    {
      file_type: fileType,
      file_name: fileName,
      upload_id: prepared.upload_id,
      srv_send_msg: false
    },
    credential,
    input.signal
  )

  return z
    .object({
      file_info: z.string().min(1),
      ttl: z.number().int().nonnegative()
    })
    .parse(response).file_info
}
