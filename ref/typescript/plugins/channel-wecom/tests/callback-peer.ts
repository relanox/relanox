import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { z } from 'zod'

export async function callbackReply(response: Response): Promise<{
  msgtype: string
  stream: {
    id: string
    finish: boolean
    content: string
    msg_item?:
      { msgtype: string; image: { base64: string; md5: string } }[] | undefined
  }
}> {
  const envelope = z
    .object({
      encrypt: z.string(),
      msgsignature: z.string(),
      timestamp: z.string(),
      nonce: z.string()
    })
    .parse(await response.json())

  const signature = createHash('sha1')
    .update(
      ['callback-token', envelope.timestamp, envelope.nonce, envelope.encrypt]
        .toSorted()
        .join('')
    )
    .digest('hex')

  if (signature !== envelope.msgsignature) {
    throw new Error('invalid reply signature')
  }

  const decipher = createDecipheriv(
    'aes-256-cbc',
    callbackKey,
    callbackKey.subarray(0, 16)
  )

  decipher.setAutoPadding(false)

  const bytes = Buffer.concat([
    decipher.update(Buffer.from(envelope.encrypt, 'base64')),
    decipher.final()
  ])

  return z
    .object({
      msgtype: z.string(),
      stream: z.object({
        id: z.string(),
        finish: z.boolean(),
        content: z.string(),
        msg_item: z
          .array(
            z.object({
              msgtype: z.string(),
              image: z.object({ base64: z.string(), md5: z.string() })
            })
          )
          .optional()
      })
    })
    .parse(
      JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32BE(16)).toString())
    )
}

export function streamRefresh(id: string, chatId = 'user'): Request {
  return callbackRequest({
    msgid: 'refresh-request',
    aibotid: 'robot',
    chattype: 'single',
    from: { userid: chatId },
    msgtype: 'stream',
    stream: { id }
  })
}

export const callbackKey = Buffer.from('0123456789abcdef0123456789abcdef')

export const callbackConfig = {
  mode: 'webhook',
  botId: 'robot',
  token: { env: 'CALLBACK_TOKEN' },
  encodingAESKey: { env: 'CALLBACK_KEY' }
}

// External WeCom wire encoder: deliberately independent of production crypto.
export function callbackRequest(
  body: unknown,
  options: {
    token?: string
    timestamp?: string
    echo?: boolean
    receiver?: string
  } = {}
): Request {
  const content = Buffer.from(
    options.echo ? String(body) : JSON.stringify(body)
  )

  const length = Buffer.alloc(4)
  length.writeUInt32BE(content.length)

  const plain = Buffer.concat([
    Buffer.alloc(16, 7),
    length,
    content,
    Buffer.from(options.receiver ?? '')
  ])

  const padding = 32 - (plain.length % 32)

  const cipher = createCipheriv(
    'aes-256-cbc',
    callbackKey,
    callbackKey.subarray(0, 16)
  )

  cipher.setAutoPadding(false)

  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])),
    cipher.final()
  ]).toString('base64')

  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const nonce = 'protocol-peer'

  const signature = createHash('sha1')
    .update(
      [options.token ?? 'callback-token', timestamp, nonce, encrypted]
        .toSorted()
        .join('')
    )
    .digest('hex')

  const url = new URL('https://relay.example/channels/bot/webhook')
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('msg_signature', signature)
  if (options.echo) {
    url.searchParams.set('echostr', encrypted)
    return new Request(url)
  }
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypt: encrypted })
  })
}

export function callbackMessage(id = 'callback-1'): Record<string, unknown> {
  return {
    msgid: id,
    aibotid: 'robot',
    chattype: 'single',
    from: { userid: 'user' },
    msgtype: 'text',
    text: { content: 'callback question' },
    response_url:
      'https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=private-reply-key'
  }
}
