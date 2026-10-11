import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

export function callbackKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=?$/u.test(value)) {
    throw new Error('invalid_callback_key')
  }
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new Error('invalid_callback_key')
  }
  return key
}

export function verifyCallback(
  url: URL,
  encrypted: string,
  token: string
): boolean {
  const signature = url.searchParams.get('msg_signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''
  if (
    !/^[a-f0-9]{40}$/iu.test(signature) ||
    !/^\d{1,12}$/u.test(timestamp) ||
    !nonce ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000
  ) {
    return false
  }

  const expected = createHash('sha1')
    .update([token, timestamp, nonce, encrypted].toSorted().join(''))
    .digest()

  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}

export function decryptCallback(encrypted: string, key: Buffer): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted)) {
    throw new Error('invalid_callback_payload')
  }
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)

  const padded = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final()
  ])

  const padding = padded.at(-1) ?? 0
  if (
    padding < 1 ||
    padded.length % 32 !== 0 ||
    padding > 32 ||
    padding > padded.length ||
    !padded.subarray(-padding).every((byte) => byte === padding)
  ) {
    throw new Error('invalid_callback_padding')
  }
  const payload = padded.subarray(0, -padding)
  if (payload.length < 20 || payload.readUInt32BE(16) !== payload.length - 20) {
    throw new Error('invalid_callback_payload')
  }
  // Native intelligent robot callbacks use an empty receiveId suffix.
  return payload.subarray(20).toString('utf8')
}
