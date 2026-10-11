import { z } from 'zod'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
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
  stagePassive,
  startPassive,
  streamId
} from './passive.js'

const maximumBody = 1024 * 1024

const callbackMessageSchema = messageSchema.extend({
  response_url: z.url().optional()
})

const callbackTargetSchema = z
  .object({
    chattype: z.enum(['single', 'group']),
    scope: z.object({ botId: z.string(), mode: z.literal('webhook') }).strict(),
    eventId: z.string().min(1)
  })
  .strict()

const replyStateSchema = z.object({
  responseUrl: z.string(),
  expiresAt: z.number(),
  chatId: z.string(),
  eventId: z.string(),
  botId: z.string(),
  streamId: z.string().default(''),
  usedAt: z.number().optional()
})

function retainedStream(
  value: unknown,
  id: string,
  chatId: string,
  botId: string
): string {
  const previous = replyStateSchema.safeParse(value)
  if (
    value !== undefined &&
    (!previous.success ||
      previous.data.chatId !== chatId ||
      previous.data.botId !== botId)
  ) {
    throw new Error('callback_identity_mismatch')
  }
  return previous.success ? previous.data.streamId : id
}

function responseUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'qyapi.weixin.qq.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/cgi-bin/aibot/response' ||
    !url.searchParams.get('response_code')
  ) {
    throw new Error('invalid_response_url')
  }
  return url.href
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

function replyBody(input: SendInput): object {
  if (input.chunk.media || input.media || input.chunkIndex > 0) {
    throw new Error('unsupported_callback_reply')
  }
  if (Buffer.byteLength(input.chunk.text) > 2048) {
    throw new Error('text_too_long')
  }

  const content = input.chunk.text

  if (Buffer.byteLength(content) > 4096) {
    throw new Error('text_too_long')
  }
  return {
    msgtype: 'markdown',
    markdown: { content }
  }
}

async function deliverCallback(
  url: string,
  body: object,
  signal: AbortSignal
): Promise<SendResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })

    if (!response.ok) {
      return { status: 'unknown', errorCode: 'callback_http_failure' }
    }

    const result = z
      .object({ errcode: z.number().int() })
      .parse(await response.json())

    return result.errcode === 0
      ? { status: 'sent', receipt: {} }
      : { status: 'rejected', errorCode: `wecom_${result.errcode}` }
  } catch {
    return { status: 'unknown', errorCode: 'transport_uncertain' }
  }
}

export function createWebhookChannel(): ChannelPlugin<WebhookConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: WebhookConfig
  let controller = new AbortController()

  let releaseSignal: (() => void) | undefined

  const stateKey = (eventId: string): string =>
    `callback:${config.botId}:${eventId}`

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
    const message = callbackMessageSchema.parse(raw)
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
    const url = message.response_url ? responseUrl(message.response_url) : ''
    const key = stateKey(message.msgid)
    const id = streamId(config.botId, message.msgid)
    const saved = await host.state.get(key)
    const passiveId = retainedStream(saved?.value, id, chatId, config.botId)
    if (!saved) {
      const expiresAt = Date.now() + 60 * 60 * 1000

      const result = await host.state.compareAndSet({
        key,
        expectedVersion: null,
        expiresAt,
        value: {
          responseUrl: url,
          expiresAt,
          chatId,
          eventId: message.msgid,
          botId: config.botId,
          streamId: id
        }
      })

      if (result.status !== 'updated' && result.status !== 'conflict') {
        throw new Error('callback_state_unavailable')
      }
    }

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
    if (passiveId) {
      await startPassive(host, passiveId, message.msgid, chatId)
    }
    await ingestText(host, {
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
    return passiveId ? passiveResponse(host, passiveId, chatId) : undefined
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
            )
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
    if (
      target.data.scope.botId !== config.botId ||
      target.data.eventId !== input.target.replyToId
    ) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
    }
    const entry = await host.state.get(stateKey(target.data.eventId))
    const state = replyStateSchema.safeParse(entry?.value)
    if (!entry || !state.success || state.data.expiresAt <= Date.now()) {
      return { status: 'rejected', errorCode: 'response_url_expired' }
    }
    if (
      state.data.botId !== config.botId ||
      state.data.eventId !== target.data.eventId ||
      state.data.chatId !== input.target.chatId
    ) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
    }
    if (state.data.usedAt !== undefined) {
      return { status: 'rejected', errorCode: 'response_url_used' }
    }
    if (state.data.streamId) {
      if (controller.signal.aborted) {
        return { status: 'retryable', errorCode: 'callback_stopped' }
      }
      return stagePassive(host, state.data.streamId, input)
    }
    let body: object
    let url: string
    try {
      body = replyBody(input)
      url = responseUrl(state.data.responseUrl)
    } catch {
      return { status: 'rejected', errorCode: 'unsupported_callback_reply' }
    }
    if (input.signal.aborted || controller.signal.aborted) {
      return { status: 'retryable', errorCode: 'callback_stopped' }
    }

    // Reserve the platform's one-use credential durably before any uncertain I/O.
    const reserved = await host.state.compareAndSet({
      key: entry.key,
      expectedVersion: entry.version,
      expiresAt: state.data.expiresAt,
      value: { ...state.data, usedAt: Date.now() }
    })

    if (reserved.status !== 'updated') {
      return { status: 'rejected', errorCode: 'response_url_used' }
    }
    return deliverCallback(
      url,
      body,
      AbortSignal.any([
        input.signal,
        controller.signal,
        AbortSignal.timeout(10_000)
      ])
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
      maxTextLength: 20_480,
      maxTextLengthPerMessage: 20_480,
      maxChunksPerMessage: 11,
      maxAttachmentsPerMessage: 10,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: { receive: ['image', 'video', 'file'], send: ['image'] }
    },
    validateConfig: (value) => webhookConfigSchema.parse(value),
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
