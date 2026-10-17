import { WecomCrypto } from '@wecom/aibot-node-sdk'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export function callbackCrypto(token: string, key: string): WecomCrypto {
  return new WecomCrypto(token, key)
}

export function encryptedCallback(body: object, crypto: WecomCrypto): object {
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(16).toString('hex')
  const encrypted = crypto.encrypt(JSON.stringify(body), timeStamp, nonce)
  return {
    encrypt: encrypted.encrypt,
    msgsignature: encrypted.signature,
    timestamp: timeStamp,
    nonce
  }
}

export function verifyCallback(
  url: URL,
  encrypted: string,
  crypto: WecomCrypto
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

  const expected = crypto.computeSignature(timestamp, nonce, encrypted)
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature, 'hex')
  )
}
