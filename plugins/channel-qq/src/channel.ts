import {
  apiBase,
  TOKEN_URL,
  configSchema,
  validateTransportUrl,
  MAX_RECONNECT_ATTEMPTS
} from './config.js'
import { downloadAttachments } from './media.js'
import { apiError } from './api-error.js'
import { uploadMedia } from './upload.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import type { WebSocket } from 'ws'
import type { z } from 'zod'
import type { QqConfig } from './config.js'
import {
  sendResponseSchema,
  gatewayResponseSchema,
  helloEventSchema,
  readyEventSchema,
  frameSchema,
  messageSchema,
  targetSchema,
  tokenSchema,
  allocationSchema,
  errorSchema
} from './schemas.js'
import {
  JsonSocketConnection,
  httpJson,
  ingestText,
  jsonPostRequest,
  RemoteError,
  secret,
  sendFailure
} from './transport.js'

type ReplyAllocation = {
  mode: 'passive' | 'proactive'
  seq: number
}

export function createQqChannel(): ChannelPlugin<QqConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: QqConfig
  let connection: JsonSocketConnection

  let token:
    { value: string; credential: string; expiresAt: number } | undefined

  let tokenFlight: Promise<string> | undefined
  let session: string | undefined
  let seq: number | null = null
  let ready = false
  let awaitingHeartbeat = false
  let dispatchQueue = Promise.resolve()
  let dispatchSocket: WebSocket | undefined

  const api = (path: string): string =>
    `${apiBase(config).replace(/\/$/u, '')}${path}`

  async function getAccessToken(signal: AbortSignal): Promise<string> {
    const credential = secret(config.clientSecret)
    if (token?.credential === credential && token.expiresAt > Date.now()) {
      return token.value
    }
    if (tokenFlight) {
      return tokenFlight
    }
    tokenFlight = (async (): Promise<string> => {
      const raw = await httpJson(
        TOKEN_URL,
        jsonPostRequest({ appId: config.appId, clientSecret: credential }),
        signal
      )

      const error = errorSchema.safeParse(raw)
      if (error.success && error.data.code !== 0) {
        throw new RemoteError({
          status: error.data.code === 100_001 ? 'retryable' : 'rejected',
          errorCode: `qq_token_${error.data.code}`
        })
      }
      const body = tokenSchema.parse(raw)
      token = {
        value: body.access_token,
        credential,
        expiresAt: Date.now() + Math.max(1, body.expires_in - 60) * 1000
      }
      return token.value
    })()
    try {
      return await tokenFlight
    } finally {
      tokenFlight = undefined
    }
  }

  const heartbeat = (): void => {
    if (awaitingHeartbeat) {
      connection.socket?.terminate()
      return
    }
    awaitingHeartbeat = true
    connection.send({ op: 1, d: seq })
  }

  async function ingestMessage(eventType: string, raw: unknown): Promise<void> {
    const message = messageSchema.parse(raw)
    if (message.author.bot) {
      return
    }
    if (
      (message.message_type !== undefined &&
        ![0, 7].includes(message.message_type)) ||
      (!message.attachments?.length && !message.content.trim()) ||
      message.attachments?.some((attachment) => !attachment.url)
    ) {
      host.observe.log('info', 'channel_unsupported_input', {
        errorCode: 'unsupported_message_type'
      })
      return
    }
    const group = eventType === 'GROUP_AT_MESSAGE_CREATE'

    const senderId = group
      ? message.author.member_openid
      : message.author.user_openid

    const chatId = group ? message.group_openid : senderId
    if (!senderId || !chatId) {
      throw new Error('missing_sender_address')
    }

    // Current docs distinguish indexed parts; never persist auth_token from message_scene.
    const index = message.message_scene?.ext
      .find((entry) => entry.startsWith('msg_idx='))
      ?.slice(8)

    const eventId = JSON.stringify([
      eventType,
      message.id,
      index ?? message.msg_seq ?? null
    ])

    const attachments = await downloadAttachments(
      message.attachments ?? [],
      host,
      config,
      connection.signal
    )

    await ingestText(host, {
      source: { channel: 'qq', accountId: account.id, eventId },
      senderId,
      text: message.content,
      attachments,
      target: {
        channel: 'qq',
        accountId: account.id,
        chatId,
        replyToId: message.id,
        data: {
          type: group ? 'group' : 'c2c',
          msgId: message.id,
          messageAt: Date.parse(message.timestamp),
          scope: { appId: config.appId, apiBase: new URL(apiBase(config)).href }
        }
      },
      receivedAt: Date.now(),
      context: null
    })
  }

  async function dispatch(frame: z.infer<typeof frameSchema>): Promise<void> {
    if (frame.t === 'READY') {
      const body = readyEventSchema.parse(frame.d)
      session = body.session_id
      ready = true
      connection.ready()
    } else if (frame.t === 'RESUMED') {
      ready = true
      connection.ready()
    } else if (
      (ready || session !== undefined) &&
      (frame.t === 'C2C_MESSAGE_CREATE' ||
        frame.t === 'GROUP_AT_MESSAGE_CREATE')
    ) {
      await ingestMessage(frame.t, frame.d)
    }
    // Resume cursor only advances after durable handoff. Control frames bypass this queue.
    if (typeof frame.s === 'number') {
      seq = frame.s
    }
  }

  async function receive(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw)
    switch (frame.op) {
      case 10: {
        const body = helloEventSchema.parse(frame.d)
        const value = await getAccessToken(connection.signal)
        connection.send(
          session && seq !== null
            ? {
                op: 6,
                d: { token: `QQBot ${value}`, session_id: session, seq }
              }
            : {
                op: 2,
                d: {
                  token: `QQBot ${value}`,
                  intents: 1 << 25,
                  shard: [0, 1],
                  properties: {}
                }
              }
        )
        awaitingHeartbeat = false
        connection.setHeartbeat(body.heartbeat_interval, heartbeat)
        return
      }
      case 11: {
        awaitingHeartbeat = false
        return
      }
      case 1: {
        awaitingHeartbeat = false
        heartbeat()
        return
      }
      case 7: {
        connection.socket?.close()
        return
      }
      case 9: {
        if (frame.d !== true) {
          session = undefined
          seq = null
        }
        connection.socket?.close()
        return
      }
      case 0: {
        if (dispatchSocket !== connection.socket) {
          dispatchSocket = connection.socket
          dispatchQueue = dispatchQueue.catch(() => {})
        }
        // A failed dispatch poisons this socket queue: no later cursor may skip it.
        const task = dispatchQueue.then(async () => dispatch(frame))
        dispatchQueue = task
        await task
      }
    }
  }

  async function allocateReplySequence(
    input: SendInput,
    target: z.infer<typeof targetSchema>
  ): Promise<ReplyAllocation | SendResult> {
    const key = `reply:${JSON.stringify([target.type, input.target.chatId, target.msgId])}`
    const max = target.type === 'c2c' ? 4 : 5
    const windowMs = target.type === 'c2c' ? 3_600_000 : 300_000
    for (let attempt = 0; attempt < 32; attempt++) {
      input.signal.throwIfAborted()
      const entry = await host.state.get(key)

      const state = entry
        ? allocationSchema.parse(entry.value)
        : {
            next: 1,
            allocations: {} as Record<string, ReplyAllocation>
          }

      const existing = Object.hasOwn(
        state.allocations,
        input.chunk.idempotencyKey
      )
        ? state.allocations[input.chunk.idempotencyKey]
        : undefined

      if (existing) {
        if (
          existing.mode === 'passive' &&
          Date.now() >= target.messageAt + windowMs
        ) {
          return { status: 'rejected', errorCode: 'passive_window_expired' }
        }
        return existing
      }

      const passive =
        Date.now() < target.messageAt + windowMs && state.next <= max

      if (!passive && !config.allowProactive) {
        return {
          status: 'rejected',
          errorCode:
            state.next > max ? 'passive_reply_limit' : 'passive_window_expired'
        }
      }
      // Avoid an unbounded plugin-state map. One inbound can emit at most 256 text chunks.
      if (Object.keys(state.allocations).length >= 256) {
        return { status: 'rejected', errorCode: 'reply_chunk_limit' }
      }

      const allocation = {
        mode: passive ? ('passive' as const) : ('proactive' as const),
        seq: state.next
      }

      const result = await host.state.compareAndSet({
        key,
        expectedVersion: entry?.version ?? null,
        value: {
          next: state.next + 1,
          allocations: {
            ...state.allocations,
            [input.chunk.idempotencyKey]: allocation
          }
        }
      })

      if (result.status === 'updated') {
        return allocation
      }
    }
    return {
      status: 'retryable',
      errorCode: 'sequence_contention',
      retryAfterMs: 1000
    }
  }

  async function transmit(
    input: SendInput,
    target: z.infer<typeof targetSchema>,
    allocation: ReplyAllocation,
    credential: string
  ): Promise<SendResult> {
    let transmitting = false
    try {
      const media = await uploadMedia(input, target.type, credential, config)
      if (typeof media !== 'string' && media !== undefined) {
        return media
      }
      transmitting = true

      const raw = await httpJson(
        api(
          `/v2/${target.type === 'c2c' ? 'users' : 'groups'}/${encodeURIComponent(input.target.chatId)}/messages`
        ),
        jsonPostRequest(
          {
            content: input.chunk.text,
            msg_type: media ? 7 : 0,
            ...(media ? { media: { file_info: media } } : {}),
            ...(allocation.mode === 'passive'
              ? { msg_id: target.msgId, msg_seq: allocation.seq }
              : {})
          },
          { Authorization: `QQBot ${credential}` }
        ),
        input.signal
      )

      const failure = apiError(raw)
      if (failure) {
        return failure
      }
      const response = sendResponseSchema.parse(raw)
      return { status: 'sent', receipt: { platformMessageId: response.id } }
    } catch (error) {
      if (
        error instanceof RemoteError &&
        error.result.errorCode === 'http_401'
      ) {
        token = undefined
        return {
          status: 'retryable',
          errorCode: 'token_expired',
          retryAfterMs: 1000
        }
      }
      if (error instanceof RemoteError) {
        const failure = apiError(error.body, !transmitting)
        if (failure) {
          return failure
        }
      }
      if (
        !transmitting &&
        error instanceof RemoteError &&
        error.result.status === 'rejected'
      ) {
        return error.result
      }
      return transmitting
        ? sendFailure(error)
        : {
            status: 'retryable',
            errorCode: 'media_upload_unavailable',
            retryAfterMs: 1000
          }
    }
  }

  return {
    id: 'channel-qq',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'qq',
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 2000,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig: (value) => configSchema.parse(value),
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = configSchema.parse(nextConfig)
      connection = new JsonSocketConnection(
        host,
        async (signal) => {
          const value = await getAccessToken(signal)

          const raw = await httpJson(
            api('/gateway'),
            { headers: { Authorization: `QQBot ${value}` } },
            signal
          )

          const body = gatewayResponseSchema.parse(raw)
          return validateTransportUrl(body.url, true, false)
        },
        async () => {},
        receive,
        (code) => {
          ready = false
          awaitingHeartbeat = false
          if (
            code === 4006 ||
            code === 4007 ||
            (code !== undefined && code >= 4900 && code <= 4913)
          ) {
            session = undefined
            seq = null
          }
          if (
            code !== undefined &&
            [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(
              code
            )
          ) {
            void connection.stop().then(() => {
              host.connection('degraded', `qq_gateway_${code}`)
              return code
            })
          }
        },
        MAX_RECONNECT_ATTEMPTS
      )
    },
    start: async (signal) => connection.start(signal),
    stop: async () => connection.stop(),
    async send(input: SendInput): Promise<SendResult> {
      const target = targetSchema.safeParse(input.target.data)
      if (
        input.target.channel !== 'qq' ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      if (
        target.data.scope.appId !== config.appId ||
        target.data.scope.apiBase !== new URL(apiBase(config)).href
      ) {
        return { status: 'rejected', errorCode: 'target_identity_changed' }
      }
      let allocation: ReplyAllocation | SendResult
      try {
        allocation = await allocateReplySequence(input, target.data)
      } catch {
        return { status: 'retryable', errorCode: 'sequence_unavailable' }
      }
      if ('status' in allocation) {
        return allocation
      }
      let credential: string
      try {
        credential = await getAccessToken(input.signal)
      } catch (error) {
        if (error instanceof RemoteError && error.result.status !== 'unknown') {
          return error.result
        }
        return { status: 'retryable', errorCode: 'token_unavailable' }
      }
      return transmit(input, target.data, allocation, credential)
    }
  }
}
