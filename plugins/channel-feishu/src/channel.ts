import { richError, richCapabilities } from './rich.js'
import { createHash } from 'node:crypto'
import { AESCipher, normalize } from '@larksuiteoapi/node-sdk'
import type { RawMessageEvent } from '@larksuiteoapi/node-sdk'
import { createSdk } from './sdk.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  ReplyTarget,
  ChannelAddress,
  Json
} from '@relanox/sdk'
import type { z } from 'zod'
import { validateConfig } from './config.js'
import type { FeishuConfig } from './config.js'
import {
  receiveMedia,
  nativeContent,
  isMediaSizeRejection,
  isMediaTokenRejection
} from './media.js'
import {
  encryptedEventSchema,
  targetSchema,
  challengeSchema,
  eventSchema,
  messageSchema
} from './schemas.js'
import { bytes, credential, equal, fresh, ingest } from './transport.js'

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

function learnedReply(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  current: Omit<z.infer<typeof targetSchema>, 'threadAnchor'>
): ReplyTarget | undefined {
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
  return learned
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
  data: z.infer<typeof targetSchema>,
  explicit: boolean
): string | undefined {
  if (explicit) {
    return target.replyToId
  }
  return target.threadId ? (data.threadAnchor ?? target.replyToId) : undefined
}

export function createFeishuChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<FeishuConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: FeishuConfig
  let botOpenId: string
  let sdk: ReturnType<typeof createSdk>

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
        value = JSON.parse(
          new AESCipher(encryptKey).decrypt(encrypted.data.encrypt)
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

  function inboundFailure(error: unknown): Response {
    if (isMediaTokenRejection(error)) {
      void sdk.invalidateToken()
    }
    if (isMediaSizeRejection(error)) {
      host.observe.count('relanox_inbound_total', {
        channel: 'feishu',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'policy'
      })
      return new Response(null, { status: 200 })
    }
    return new Response(null, { status: 503 })
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
      return new Response(null, { status: 200 })
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
      return new Response(null, { status: 200 })
    }
    if (sender.tenant_key && sender.tenant_key !== config.tenantKey) {
      return new Response(null, { status: 401 })
    }
    if (!account.allowedSenders.includes(sender.sender_id.open_id)) {
      host.observe.count('relanox_inbound_total', {
        channel: 'feishu',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'policy'
      })
      return new Response(null, { status: 200 })
    }
    try {
      const content = await normalize(messageEvent.data as RawMessageEvent, {
        botIdentity: { openId: botOpenId, name: 'bot' },
        stripBotMentions: true
      })

      const threadId = message.thread_id

      await ingest(host, {
        source: {
          channel: 'feishu',
          accountId: account.id,
          eventId: header.event_id
        },
        senderId: sender.sender_id.open_id,
        text: content.content,
        attachments: await receiveMedia(
          message.message_id,
          content.resources,
          host,
          sdk.channel
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
      return new Response(null, { status: 200 })
    } catch (error) {
      return inboundFailure(error)
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
      const prior = learnedReply(address, learned, current)
      let threadAnchor: string | undefined
      if (address.threadId !== undefined) {
        const data = targetSchema.safeParse(prior?.data)
        threadAnchor = data.success
          ? (data.data.threadAnchor ?? prior?.replyToId)
          : undefined
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
          ...(prior?.replyToId ? { replyToId: prior.replyToId } : {}),
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

      sdk = createSdk(config, environment)
      await sdk.channel.connect()
      if (!sdk.channel.botIdentity?.openId) {
        throw new Error('feishu_identity_unavailable')
      }
      botOpenId = sdk.channel.botIdentity.openId
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
    stop: async () => sdk.stop(),
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
      if (
        (input.target.threadId || input.reply) &&
        !threadReply(input.target, data.data, Boolean(input.reply))
      ) {
        return { status: 'rejected', errorCode: 'address_unresolved' }
      }
      const errorCode = richError(input)
      if (errorCode) {
        return { status: 'rejected', errorCode }
      }
      if (input.chunk.media && !input.media) {
        return { status: 'rejected', errorCode: 'missing_media' }
      }
      if (input.chunk.media && input.chunk.text) {
        return { status: 'rejected', errorCode: 'media_caption_unsupported' }
      }
      return sdk.run(input.signal, async () => {
        const content = await nativeContent(input, sdk.channel)
        input.signal.throwIfAborted()
        const reply = threadReply(input.target, data.data, Boolean(input.reply))

        const sent = await sdk.channel.send(
          input.target.chatId,
          content,
          reply
            ? { replyTo: reply, replyInThread: Boolean(input.target.threadId) }
            : {}
        )

        return sent.messageId
          ? { status: 'sent', receipt: { platformMessageId: sent.messageId } }
          : { status: 'unknown', errorCode: 'invalid_platform_response' }
      })
    }
  }
}
