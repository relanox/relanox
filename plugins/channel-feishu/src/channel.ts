import { richError, richCapabilities } from './rich.js'
import { createDecipheriv, createHash } from 'node:crypto'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendResult,
  ReplyTarget,
  ChannelAddress,
  Json
} from '@relanox/sdk'
import { z } from 'zod'
import { validateConfig, REQUEST_TIMEOUT_MS } from './config.js'
import type { FeishuConfig } from './config.js'
import {
  receiveMedia,
  messageContent,
  mediaError,
  parseContent
} from './media.js'
import {
  encryptedEventSchema,
  tenantTokenResponseSchema,
  targetSchema,
  challengeSchema,
  eventSchema,
  messageSchema,
  apiSchema
} from './schemas.js'
import {
  bytes,
  credential,
  equal,
  failure,
  fresh,
  ingest,
  jsonResponse,
  postJson
} from './transport.js'

const botInfoSchema = z.object({
  code: z.literal(0),
  bot: z.object({ open_id: z.string().min(1) })
})

function matchesIdentity(
  data: z.infer<typeof targetSchema>,
  current: Omit<z.infer<typeof targetSchema>, 'threadAnchor'>
): boolean {
  return (
    data.tenantKey === current.tenantKey &&
    data.appId === current.appId &&
    data.botId === current.botId &&
    data.apiBaseUrl === current.apiBaseUrl
  )
}

function learnedAnchor(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  current: Omit<z.infer<typeof targetSchema>, 'threadAnchor'>
): string | undefined {
  const prior = targetSchema.safeParse(learned?.data)
  if (
    learned?.channel !== 'feishu' ||
    learned.accountId !== address.accountId ||
    learned.chatId !== address.chatId ||
    learned.threadId !== address.threadId ||
    !prior.success ||
    !matchesIdentity(prior.data, current)
  ) {
    return undefined
  }
  return prior.data.threadAnchor ?? learned.replyToId
}

function threadIdentity(
  data: Json,
  threadId: string | undefined,
  message: z.infer<typeof messageSchema>['message']
): Json {
  if (!threadId) {
    return data
  }
  return {
    ...targetSchema.parse(data),
    threadAnchor: message.root_id ?? message.message_id
  }
}

function threadReply(
  target: ReplyTarget,
  data: z.infer<typeof targetSchema>
): string | undefined {
  return target.threadId
    ? (data.threadAnchor ?? target.replyToId)
    : target.replyToId
}

export function createFeishuChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<FeishuConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: FeishuConfig
  let botOpenId: string
  let token: { value: string; until: number; secretDigest: string } | undefined

  const base = (): string =>
    config.domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn'

  const identity = (): {
    tenantKey: string
    appId: string
    botId: string
    apiBaseUrl: string
  } => ({
    tenantKey: config.tenantKey,
    appId: config.appId,
    botId: botOpenId,
    apiBaseUrl: new URL(base()).toString().replace(/\/$/u, '')
  })

  async function accessToken(
    signal: AbortSignal
  ): Promise<string | SendResult> {
    const appSecret = credential(config.appSecret, environment)
    const secretDigest = createHash('sha256').update(appSecret).digest('hex')
    if (
      token &&
      token.until > Date.now() &&
      token.secretDigest === secretDigest
    ) {
      return token.value
    }

    const response = await postJson(
      `${base().replace(/\/$/u, '')}/open-apis/auth/v3/tenant_access_token/internal`,
      {},
      { app_id: config.appId, app_secret: appSecret },
      signal,
      REQUEST_TIMEOUT_MS
    )

    if (!response.ok) {
      return response.status >= 500
        ? { status: 'retryable', errorCode: 'tenant_token_unavailable' }
        : failure(response)
    }

    const parsed = tenantTokenResponseSchema.safeParse(
      await jsonResponse(response)
    )

    if (!parsed.success) {
      return { status: 'retryable', errorCode: 'tenant_token_unavailable' }
    }
    if (parsed.data.code !== 0) {
      return { status: 'rejected', errorCode: 'tenant_token_unavailable' }
    }
    if (!parsed.data.tenant_access_token || !parsed.data.expire) {
      return { status: 'retryable', errorCode: 'tenant_token_unavailable' }
    }
    token = {
      value: parsed.data.tenant_access_token,
      until: Date.now() + Math.max(0, parsed.data.expire * 1000 - 60_000),
      secretDigest
    }
    return token.value
  }

  async function sendOutcome(response: Response): Promise<SendResult> {
    if (!response.ok) {
      return failure(response)
    }
    const parsed = apiSchema.safeParse(await jsonResponse(response))
    if (!parsed.success) {
      return { status: 'unknown', errorCode: 'invalid_platform_response' }
    }
    if (parsed.data.code !== 0) {
      token = undefined
      return { status: 'rejected', errorCode: 'feishu_api_error' }
    }
    return parsed.data.data?.message_id
      ? {
          status: 'sent',
          receipt: { platformMessageId: parsed.data.data.message_id }
        }
      : { status: 'unknown', errorCode: 'invalid_platform_response' }
  }

  async function verifyRequest(request: Request): Promise<unknown> {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405 })
    }
    let raw: Buffer
    try {
      raw = await bytes(request)
    } catch {
      return new Response(null, { status: 413 })
    }
    const encryptKey = credential(config.encryptKey, environment)
    const suppliedSignature = request.headers.get('x-lark-signature')
    if (suppliedSignature !== null) {
      const timestamp = request.headers.get('x-lark-request-timestamp')
      const nonce = request.headers.get('x-lark-request-nonce')
      if (!fresh(timestamp) || !nonce || nonce.length > 256) {
        return new Response(null, { status: 401 })
      }

      const signature = createHash('sha256')
        .update(`${timestamp}${nonce}${encryptKey}`)
        .update(raw)
        .digest('hex')

      if (!equal(signature, suppliedSignature)) {
        return new Response(null, { status: 401 })
      }
    }
    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8'))
      const encrypted = encryptedEventSchema.safeParse(value)
      if (encrypted.success) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted.data.encrypt)) {
          throw new Error('invalid_encryption')
        }
        const payload = Buffer.from(encrypted.data.encrypt, 'base64')
        if (payload.length < 32 || payload.length % 16) {
          throw new Error('invalid_encryption')
        }

        const decipher = createDecipheriv(
          'aes-256-cbc',
          createHash('sha256').update(encryptKey).digest(),
          payload.subarray(0, 16)
        )

        value = JSON.parse(
          Buffer.concat([
            decipher.update(payload.subarray(16)),
            decipher.final()
          ]).toString('utf8')
        )
      }
    } catch {
      return new Response(null, { status: 400 })
    }

    // Registration challenges precede event-signature setup; the handler checks their token.
    if (
      suppliedSignature === null &&
      !challengeSchema.safeParse(value).success
    ) {
      return new Response(null, { status: 401 })
    }
    return value
  }

  async function receiveEvent(
    event: z.infer<typeof eventSchema>
  ): Promise<Response> {
    const { header } = event
    if (
      !equal(header.token, credential(config.verificationToken, environment)) ||
      header.app_id !== config.appId ||
      header.tenant_key !== config.tenantKey
    ) {
      return new Response(null, { status: 401 })
    }
    if (header.event_type !== 'im.message.receive_v1') {
      host.observe.count('relanox_inbound_total', {
        channel: 'feishu',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'unsupported'
      })
      return new Response(null, { status: 204 })
    }
    const messageEvent = messageSchema.safeParse(event.event)
    if (!messageEvent.success) {
      return new Response(null, { status: 400 })
    }
    const { message, sender } = messageEvent.data
    if (
      sender.sender_type !== 'user' ||
      sender.sender_id.open_id === botOpenId ||
      !['text', 'image', 'audio', 'media', 'file', 'post'].includes(
        message.message_type
      ) ||
      !sender.sender_id.open_id
    ) {
      host.observe.count('relanox_inbound_total', {
        channel: 'feishu',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'unsupported'
      })
      return new Response(null, { status: 204 })
    }
    if (sender.tenant_key && sender.tenant_key !== config.tenantKey) {
      return new Response(null, { status: 401 })
    }
    let content: ReturnType<typeof parseContent>
    try {
      content = parseContent(message)
    } catch {
      return new Response(null, { status: 400 })
    }
    try {
      const threadId = message.thread_id ?? message.root_id

      const access =
        content.resources.length > 0
          ? await accessToken(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
          : ''

      if (typeof access !== 'string') {
        return new Response(null, { status: 503 })
      }
      await ingest(host, {
        source: {
          channel: 'feishu',
          accountId: account.id,
          eventId: header.event_id
        },
        senderId: sender.sender_id.open_id,
        text: content.text,
        attachments: await receiveMedia(
          message.message_id,
          content,
          host,
          config,
          base(),
          access
        ),
        target: {
          channel: 'feishu',
          accountId: account.id,
          chatId: message.chat_id,
          ...(threadId ? { threadId } : {}),
          replyToId: message.message_id,
          data: threadIdentity(identity(), threadId, message)
        },
        context: {
          tenantKey: config.tenantKey
        },
        receivedAt: Date.now()
      })
      return new Response(null, { status: 204 })
    } catch {
      return new Response(null, { status: 503 })
    }
  }

  return {
    id: 'channel-feishu',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'feishu',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 10_000,
      richText: richCapabilities,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'feishu' ||
        address.accountId !== account.id ||
        !/^[A-Za-z0-9_-]+$/u.test(address.chatId) ||
        (address.threadId !== undefined &&
          !/^[A-Za-z0-9_-]+$/u.test(address.threadId))
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const current = identity()
      let threadAnchor: string | undefined
      if (address.threadId !== undefined) {
        threadAnchor = learnedAnchor(address, learned, current)
        if (!threadAnchor || !/^[A-Za-z0-9_-]+$/u.test(threadAnchor)) {
          return { status: 'unavailable', reason: 'address_unresolved' }
        }
      }
      return {
        status: 'available',
        target: {
          channel: 'feishu',
          accountId: account.id,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          data: { ...current, ...(threadAnchor ? { threadAnchor } : {}) }
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = nextConfig
      credential(config.appSecret, environment)
      credential(config.encryptKey, environment)
      credential(config.verificationToken, environment)

      const tenantToken = await accessToken(
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      )

      if (typeof tenantToken !== 'string') {
        throw new TypeError('feishu_identity_unavailable')
      }

      const response = await fetch(`${base()}/open-apis/bot/v3/info`, {
        redirect: 'error',
        headers: { authorization: `Bearer ${tenantToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('feishu_identity_unavailable')
      }
      botOpenId = botInfoSchema.parse(await jsonResponse(response)).bot.open_id
      host.mountHttp('/events', async (request) => {
        const value = await verifyRequest(request)
        if (value instanceof Response) {
          return value
        }
        const challenge = challengeSchema.safeParse(value)
        if (challenge.success) {
          if (
            !equal(
              challenge.data.token,
              credential(config.verificationToken, environment)
            )
          ) {
            return new Response(null, { status: 401 })
          }
          return Response.json({ challenge: challenge.data.challenge })
        }
        const parsed = eventSchema.safeParse(value)
        if (!parsed.success) {
          return new Response(null, { status: 400 })
        }
        return receiveEvent(parsed.data)
      })
    },
    async send(input) {
      const data = targetSchema.safeParse(input.target.data)
      const current = identity()
      if (
        input.target.channel !== 'feishu' ||
        input.target.accountId !== account.id ||
        !/^[A-Za-z0-9_-]+$/u.test(input.target.chatId) ||
        (input.target.replyToId &&
          !/^[A-Za-z0-9_-]+$/u.test(input.target.replyToId)) ||
        !data.success ||
        !matchesIdentity(data.data, current)
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      if (input.target.threadId && !threadReply(input.target, data.data)) {
        return { status: 'rejected', errorCode: 'address_unresolved' }
      }
      // Authentication precedes the message effect, so failures here are safe to retry.
      const errorCode = richError(input, host) ?? mediaError(input, host)
      if (errorCode) {
        return { status: 'rejected', errorCode }
      }

      const access = await accessToken(input.signal).catch(() => ({
        status: 'retryable' as const,
        errorCode: 'tenant_token_transport_error'
      }))

      if (typeof access !== 'string') {
        return access
      }

      const content = await messageContent(
        input,
        host,
        config,
        base(),
        access
      ).catch(() => ({
        status: 'retryable' as const,
        errorCode: 'media_upload_transport_error'
      }))

      if ('status' in content) {
        return content
      }
      try {
        const reply = threadReply(input.target, data.data)

        const response = await postJson(
          `${base().replace(/\/$/u, '')}/open-apis/im/v1/messages${reply ? `/${encodeURIComponent(reply)}/reply` : '?receive_id_type=chat_id'}`,
          { authorization: `Bearer ${access}` },
          {
            ...content,
            ...(reply
              ? { reply_in_thread: Boolean(input.target.threadId) }
              : { receive_id: input.target.chatId })
          },
          input.signal,
          REQUEST_TIMEOUT_MS
        )

        return await sendOutcome(response)
      } catch {
        return { status: 'unknown', errorCode: 'feishu_transport_error' }
      }
    }
  }
}
