import {
  WEBSOCKET_URL,
  configSchema,
  websocketConfigSchema,
  validateTransportUrl,
  HEARTBEAT_MS,
  MAX_RECONNECT_ATTEMPTS
} from './config.js'
import {
  receiveParts,
  uploadResource,
  outgoingBody,
  uploadFailure
} from './media.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { WeComConfig, WebsocketConfig } from './config.js'
import { createWebhookChannel } from './webhook.js'
import {
  frameSchema,
  messageSchema,
  targetSchema,
  botEventSchema
} from './schemas.js'
import { JsonSocketConnection, ingestText, secret } from './transport.js'

type Frame = z.infer<typeof frameSchema>

function configuredType(
  types: WebsocketConfig['recipientTypes'],
  chatId: string
): 'single' | 'group' | undefined {
  return types && Object.hasOwn(types, chatId) ? types[chatId] : undefined
}

export function createWeComChannel(): ChannelPlugin<WeComConfig> {
  const websocket = createWebsocketChannel()

  let channel: Pick<
    ChannelPlugin,
    'start' | 'stop' | 'send' | 'capabilities' | 'resolveChannel'
  > = websocket

  return {
    ...websocket,
    get capabilities() {
      return { ...channel.capabilities, transport: 'both' as const }
    },
    validateConfig: (value) => configSchema.parse(value),
    async setup(host, account, config) {
      const parsed = configSchema.parse(config)
      if (parsed.mode === 'webhook') {
        const webhook = createWebhookChannel()
        await webhook.setup(host, account, parsed)
        channel = webhook
      } else {
        await websocket.setup(host, account, parsed)
        channel = websocket
      }
    },
    start: async (signal) => channel.start?.(signal),
    stop: async () => channel.stop?.(),
    resolveChannel: async (address, learned) =>
      channel.resolveChannel
        ? channel.resolveChannel(address, learned)
        : { status: 'unavailable', reason: 'address_unresolved' },
    send: async (input) => channel.send(input)
  }
}

function createWebsocketChannel(): ChannelPlugin<WebsocketConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: WebsocketConfig
  let connection: JsonSocketConnection
  let authenticated = false

  const pending = new Map<
    string,
    { resolve(frame: Frame): void; reject(): void }
  >()

  async function request(
    cmd: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<Frame> {
    const id = randomUUID()
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const fail = (): void => {
        cleanup()
        reject(new Error('request_uncertain'))
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', fail)
        pending.delete(id)
      }

      const timer = setTimeout(fail, 10_000)
      pending.set(id, {
        resolve: (frame) => {
          cleanup()
          resolve(frame)
        },
        reject: fail
      })
      signal.addEventListener('abort', fail, { once: true })
      try {
        connection.send({
          cmd,
          headers: { req_id: id },
          ...(body === undefined ? {} : { body })
        })
      } catch {
        fail()
      }
    })
  }

  async function receive(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw)
    if (frame.errcode !== undefined) {
      pending.get(frame.headers.req_id)?.resolve(frame)
      return
    }
    if (frame.cmd === 'aibot_event_callback') {
      const event = botEventSchema.parse(frame.body)
      if (
        event.aibotid === config.botId &&
        event.event.eventtype === 'disconnected_event'
      ) {
        await connection.stop()
        host.connection('degraded', 'bot_connection_replaced')
        host.observe.log('warn', 'channel_connection_replaced', {
          errorCode: 'bot_connection_replaced'
        })
      }
      return
    }
    if (!authenticated || frame.cmd !== 'aibot_msg_callback') {
      return
    }
    const message = messageSchema.parse(frame.body)
    if (
      message.aibotid !== config.botId ||
      message.from.userid === config.botId
    ) {
      return
    }
    if (
      !['text', 'image', 'file', 'video', 'mixed', 'voice'].includes(
        message.msgtype
      )
    ) {
      host.observe.log('info', 'channel_unsupported_input', {
        errorCode: 'unsupported_message_type'
      })
      return
    }

    const chatId =
      message.chattype === 'group' ? message.chatid : message.from.userid

    if (!chatId) {
      throw new Error('missing_group_address')
    }

    if (host.discoverConversation) {
      host.discoverConversation({ chatId, senderId: message.from.userid })
      return
    }
    if (!account.allowedSenders.includes(message.from.userid)) {
      host.observe.log('info', 'channel_input_discarded', {
        errorCode: 'sender_not_allowed'
      })
      return
    }

    const { text, attachments } = await receiveParts(
      message,
      host,
      connection.signal
    )

    if (!text && attachments.length === 0) {
      return
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
          scope: { botId: config.botId, wsUrl: new URL(WEBSOCKET_URL).href }
        }
      },
      receivedAt: Date.now(),
      context: null
    })
  }

  return {
    id: 'channel-wecom',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'wecom',
    // Independent sends have no documented idempotency promise.
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 20_480,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: {
        receive: ['image', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig: (value) => websocketConfigSchema.parse(value),
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'wecom' ||
        address.accountId !== account.id ||
        !address.chatId ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const prior = targetSchema.safeParse(learned?.data)

      const known =
        learned?.channel === 'wecom' &&
        learned.accountId === account.id &&
        learned.chatId === address.chatId &&
        learned.threadId === undefined &&
        prior.success &&
        prior.data.scope.botId === config.botId &&
        prior.data.scope.wsUrl === new URL(WEBSOCKET_URL).href
          ? prior.data.chattype
          : undefined

      const chattype =
        configuredType(config.recipientTypes, address.chatId) ?? known

      if (!chattype) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }
      return {
        status: 'available',
        target: {
          channel: 'wecom',
          accountId: account.id,
          chatId: address.chatId,
          data: {
            chattype,
            scope: { botId: config.botId, wsUrl: new URL(WEBSOCKET_URL).href }
          }
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = websocketConfigSchema.parse(nextConfig)
      connection = new JsonSocketConnection(
        host,
        async () => validateTransportUrl(WEBSOCKET_URL, true, false),
        async () => {
          const result = await request(
            'aibot_subscribe',
            { bot_id: config.botId, secret: secret(config.secret) },
            connection.signal
          )

          if (result.errcode !== 0) {
            connection.socket?.terminate()
            throw new Error('authentication_failed')
          }
          authenticated = true
          connection.ready()
          let awaiting = false
          connection.setHeartbeat(HEARTBEAT_MS, () => {
            if (awaiting) {
              connection.socket?.terminate()
              return
            }
            awaiting = true
            void (async (): Promise<void> => {
              try {
                const response = await request(
                  'ping',
                  undefined,
                  connection.signal
                )

                if (response.errcode !== 0) {
                  connection.socket?.terminate()
                }
              } catch {
                connection.socket?.terminate()
              } finally {
                awaiting = false
              }
            })()
          })
        },
        receive,
        () => {
          authenticated = false
          for (const p of pending.values()) {
            p.reject()
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
        input.target.channel !== 'wecom' ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      if (
        target.data.scope.botId !== config.botId ||
        target.data.scope.wsUrl !== new URL(WEBSOCKET_URL).href
      ) {
        return { status: 'rejected', errorCode: 'target_identity_changed' }
      }
      if (!authenticated) {
        return {
          status: 'retryable',
          errorCode: 'not_connected',
          retryAfterMs: 1000
        }
      }

      const content = input.chunk.text

      if (Buffer.byteLength(content) > 20_480) {
        return { status: 'rejected', errorCode: 'text_too_long' }
      }
      let transmitting = false
      try {
        if (input.chunk.media && !input.media) {
          return { status: 'rejected', errorCode: 'missing_media' }
        }

        const mediaId = input.media
          ? await uploadResource(input.media, request, input.signal)
          : undefined

        transmitting = true

        const response = await request(
          'aibot_send_msg',
          {
            chatid: input.target.chatId,
            chat_type: target.data.chattype === 'single' ? 1 : 2,
            ...outgoingBody(input.media, mediaId, content)
          },
          input.signal
        )

        if (response.errcode === 0) {
          return { status: 'sent', receipt: {} }
        }
        if (response.errcode === -1 || response.errcode === 45_009) {
          return {
            status: 'retryable',
            errorCode: `wecom_${response.errcode}`,
            retryAfterMs: 1000
          }
        }
        return { status: 'rejected', errorCode: `wecom_${response.errcode}` }
      } catch (error) {
        return transmitting
          ? { status: 'unknown', errorCode: 'transport_uncertain' }
          : uploadFailure(error)
      }
    }
  }
}
