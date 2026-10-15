import { z } from 'zod'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
  ChannelAddress,
  ReplyTarget
} from '@relanox/sdk'
import { webhookConfigSchema } from './config.js'
import type { WebhookConfig } from './config.js'
import {
  callbackKey,
  encryptedCallback,
  decryptCallback,
  verifyCallback
} from './callback-crypto.js'
import { messageSchema } from './schemas.js'
import { receiveParts } from './media.js'
import { ingestText, secret } from './transport.js'
import {
  passiveResponse,
  passiveAvailability,
  stagePassive,
  startPassive,
  streamId
} from './passive.js'

const maximumBody = 1024 * 1024

const callbackTargetSchema = z
  .object({
    chattype: z.enum(['single', 'group']),
    scope: z.object({ botId: z.string(), mode: z.literal('webhook') }).strict(),
    eventId: z.string().min(1)
  })
  .strict()

function learnedCallback(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  botId: string
): z.infer<typeof callbackTargetSchema> | undefined {
  const prior = callbackTargetSchema.safeParse(learned?.data)
  if (
    learned?.channel !== 'wecom' ||
    learned.accountId !== address.accountId ||
    learned.chatId !== address.chatId ||
    learned.threadId !== undefined ||
    !prior.success ||
    prior.data.scope.botId !== botId
  ) {
    return undefined
  }
  return prior.data
}

function matchesReply(
  target: z.infer<typeof callbackTargetSchema>,
  input: SendInput,
  botId: string
): boolean {
  return (
    target.scope.botId === botId &&
    (input.target.replyToId === undefined ||
      target.eventId === input.target.replyToId)
  )
}

async function requestBody(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) {
    throw new Error('invalid_callback_body')
  }
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) {
        return Buffer.concat(parts).toString('utf8')
      }
      size += part.value.byteLength
      if (size > maximumBody) {
        await reader.cancel()
        throw new Error('callback_body_too_large')
      }
      parts.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
}

export function createWebhookChannel(): ChannelPlugin<WebhookConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: WebhookConfig
  let controller = new AbortController()

  let releaseSignal: (() => void) | undefined

  async function receive(
    raw: unknown,
    signal: AbortSignal
  ): Promise<object | undefined> {
    const envelope = z
      .object({ aibotid: z.string(), msgtype: z.string() })
      .parse(raw)

    if (envelope.aibotid !== config.botId) {
      throw new Error('callback_identity_mismatch')
    }
    if (envelope.msgtype === 'stream') {
      const refresh = z
        .object({
          stream: z.object({ id: z.string().min(1) }),
          chattype: z.enum(['single', 'group']),
          chatid: z.string().min(1).optional(),
          from: z.object({ userid: z.string().min(1) })
        })
        .parse(raw)

      const chatId =
        refresh.chattype === 'group' ? refresh.chatid : refresh.from.userid

      if (!chatId) {
        throw new Error('missing_group_address')
      }
      return passiveResponse(host, refresh.stream.id, chatId)
    }
    if (
      !['text', 'image', 'file', 'video', 'mixed', 'voice'].includes(
        envelope.msgtype
      )
    ) {
      return undefined
    }
    const message = messageSchema.parse(raw)
    if (message.from.userid === config.botId) {
      return undefined
    }

    const chatId =
      message.chattype === 'group' ? message.chatid : message.from.userid

    if (!chatId) {
      throw new Error('missing_group_address')
    }
    if (host.discoverConversation) {
      host.discoverConversation({ chatId, senderId: message.from.userid })
      return undefined
    }
    if (!account.allowedSenders.includes(message.from.userid)) {
      host.observe.log('info', 'channel_input_discarded', {
        errorCode: 'sender_not_allowed'
      })
      return undefined
    }
    const id = streamId(config.botId, message.msgid)

    const { text, attachments } = await receiveParts(
      message,
      host,
      signal,
      secret(config.encodingAESKey)
    )

    if (!text && attachments.length === 0) {
      return undefined
    }
    signal.throwIfAborted()
    await startPassive(host, id, message.msgid, chatId)

    const accepted = await ingestText(host, {
      source: {
        channel: 'wecom',
        accountId: account.id,
        eventId: message.msgid
      },
      senderId: message.from.userid,
      text,
      attachments,
      target: {
        channel: 'wecom',
        accountId: account.id,
        chatId,
        replyToId: message.msgid,
        data: {
          chattype: message.chattype,
          scope: { botId: config.botId, mode: 'webhook' },
          eventId: message.msgid
        }
      },
      receivedAt: Date.now(),
      context: null
    })

    return accepted ? passiveResponse(host, id, chatId) : undefined
  }

  async function callback(request: Request): Promise<Response> {
    if (controller.signal.aborted) {
      return new Response(null, { status: 503 })
    }
    if (!['GET', 'POST'].includes(request.method)) {
      return new Response(null, { status: 405 })
    }
    const url = new URL(request.url)
    let plain: string
    try {
      const encrypted =
        request.method === 'GET'
          ? (url.searchParams.get('echostr') ?? '')
          : z
              .object({ encrypt: z.string().min(1) })
              .parse(JSON.parse(await requestBody(request))).encrypt

      if (!verifyCallback(url, encrypted, secret(config.token))) {
        return new Response(null, { status: 401 })
      }
      plain = decryptCallback(
        encrypted,
        callbackKey(secret(config.encodingAESKey))
      )
    } catch {
      return new Response(null, { status: 400 })
    }
    if (request.method === 'GET') {
      return new Response(plain, { headers: { 'content-type': 'text/plain' } })
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(plain)
    } catch {
      return new Response(null, { status: 400 })
    }
    try {
      const body = await receive(
        decoded,
        AbortSignal.any([controller.signal, request.signal])
      )

      return body
        ? Response.json(
            encryptedCallback(
              body,
              callbackKey(secret(config.encodingAESKey)),
              secret(config.token)
            ),
            { headers: { 'content-type': 'text/plain; charset=utf-8' } }
          )
        : new Response(null, { status: 200 })
    } catch {
      return new Response(null, { status: 503 })
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const target = callbackTargetSchema.safeParse(input.target.data)
    if (
      input.target.channel !== 'wecom' ||
      input.target.accountId !== account.id ||
      !target.success
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    if (!matchesReply(target.data, input, config.botId)) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
    }
    if (controller.signal.aborted) {
      return { status: 'retryable', errorCode: 'callback_stopped' }
    }
    return stagePassive(
      host,
      streamId(config.botId, target.data.eventId),
      input
    )
  }

  return {
    id: 'channel-wecom',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'wecom',
    capabilities: {
      receive: true,
      transport: 'both',
      maxTextLength: 20 * 1024,
      maxTextLengthPerMessage: 20 * 1024,
      maxChunksPerMessage: 11,
      maxAttachmentsPerMessage: 10,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: { receive: ['image', 'video', 'file'], send: ['image'] }
    },
    validateConfig: (value) => webhookConfigSchema.parse(value),
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'wecom' ||
        address.accountId !== account.id ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const prior = learnedCallback(address, learned, config.botId)
      if (!prior) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }

      const reason = await passiveAvailability(
        host,
        streamId(config.botId, prior.eventId),
        prior.eventId,
        address.chatId
      )

      if (reason) {
        return { status: 'unavailable', reason }
      }
      return {
        status: 'available',
        target: {
          channel: 'wecom',
          accountId: account.id,
          chatId: address.chatId,
          data: prior
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = webhookConfigSchema.parse(nextConfig)
      callbackKey(secret(config.encodingAESKey))
      secret(config.token)
      host.mountHttp('/webhook', callback, {
        maxBodyBytes: maximumBody,
        authorize: async () => {}
      })
    },
    async start(signal) {
      signal.throwIfAborted()
      releaseSignal?.()
      controller = new AbortController()
      const active = controller

      const abort = (): void => {
        active.abort()
        host.connection('disconnected')
      }

      signal.addEventListener('abort', abort, { once: true })
      releaseSignal = (): void => {
        signal.removeEventListener('abort', abort)
      }
      host.connection('connected')
    },
    async stop() {
      releaseSignal?.()
      releaseSignal = undefined
      controller.abort()
      host.connection('disconnected')
    },
    send
  }
}
