import { createHmac, timingSafeEqual } from 'node:crypto'

export function signed(
  body: Uint8Array,
  header: string | null,
  key: string,
  encoding: 'hex' | 'base64',
  prefix = ''
): boolean {
  if (!header?.startsWith(prefix)) {
    return false
  }
  const supplied = header.slice(prefix.length)
  const expected = createHmac('sha256', key).update(body).digest(encoding)
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
