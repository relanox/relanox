import { WEBSOCKET_URL, configSchema, websocketConfigSchema } from './config.js'
import {
  receiveParts,
  uploadResource,
  outgoingBody,
  uploadFailure,
  nativeFailure
} from './media.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
  ChannelAddress,
  ReplyTarget
} from '@relanox/sdk'
import { WSClient } from '@wecom/aibot-node-sdk'
import type { z } from 'zod'
import type { WeComConfig, WebsocketConfig } from './config.js'
import { createWebhookChannel } from './webhook.js'
import { frameSchema, messageSchema, targetSchema } from './schemas.js'
import { ingestText, secret } from './transport.js'

type Frame = z.infer<typeof frameSchema>

function configuredType(
  types: WebsocketConfig['recipientTypes'],
  chatId: string
): 'single' | 'group' | undefined {
  return types && Object.hasOwn(types, chatId) ? types[chatId] : undefined
}

function learnedSocketTarget(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  botId: string
): { target: ReplyTarget; data: z.infer<typeof targetSchema> } | undefined {
  const prior = targetSchema.safeParse(learned?.data)
  if (
    learned?.channel !== 'wecom' ||
    learned.accountId !== address.accountId ||
    learned.chatId !== address.chatId ||
    learned.threadId !== undefined ||
    !prior.success ||
    prior.data.scope.botId !== botId ||
    prior.data.scope.wsUrl !== new URL(WEBSOCKET_URL).href
  ) {
    return undefined
  }
  return { target: learned, data: prior.data }
}

function socketOutcome(response: Frame): SendResult {
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
  let client: WSClient | undefined
  let controller = new AbortController()
  let releaseSignal: (() => void) | undefined
  let finishStart: (() => void) | undefined
  let replaced = false
  let authenticated = false

  async function receive(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw)
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
      controller.signal
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
          callbackReqId: frame.headers.req_id,
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
      maxTextLength: 20 * 1024,
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
      const known = learnedSocketTarget(address, learned, config.botId)

      const chattype =
        configuredType(config.recipientTypes, address.chatId) ??
        known?.data.chattype

      if (!chattype) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }
      const selected = known?.data.chattype === chattype ? known : undefined
      return {
        status: 'available',
        target: {
          channel: 'wecom',
          accountId: account.id,
          chatId: address.chatId,
          ...(selected?.target.replyToId
            ? { replyToId: selected.target.replyToId }
            : {}),
          data: {
            chattype,
            ...(selected?.data.callbackReqId
              ? { callbackReqId: selected.data.callbackReqId }
              : {}),
            scope: { botId: config.botId, wsUrl: new URL(WEBSOCKET_URL).href }
          }
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = websocketConfigSchema.parse(nextConfig)
    },
    async start(signal) {
      signal.throwIfAborted()
      controller = new AbortController()

      const abort = (): void => {
        controller.abort()
        client?.disconnect()
        finishStart?.()
        authenticated = false
        host.connection('disconnected')
      }

      releaseSignal?.()
      signal.addEventListener('abort', abort, { once: true })
      releaseSignal = (): void => {
        signal.removeEventListener('abort', abort)
      }
      try {
        const quiet = (): void => {}
        client = new WSClient({
          botId: config.botId,
          secret: secret(config.secret),
          wsOptions: { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 },
          logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }
        })
      } catch {
        host.connection('degraded', 'missing_secret')
        return
      }
      const active = client
      active.on('message', (frame) => {
        void receive(frame).catch(() => {
          if (!controller.signal.aborted) {
            host.connection('degraded', 'ingest_failed')
          }
        })
      })
      active.on('event.disconnected_event', () => {
        replaced = true
        authenticated = false
        host.connection('degraded', 'bot_connection_replaced')
      })
      active.on('disconnected', () => {
        authenticated = false
        host.connection(replaced ? 'degraded' : 'disconnected')
      })
      active.on('reconnecting', () => {
        host.connection('degraded', 'reconnecting')
      })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          host.connection('degraded', 'authentication_timeout')
          active.disconnect()
          resolve()
        }, 10_000)

        const ready = (): void => {
          clearTimeout(timer)
          finishStart = undefined
          resolve()
        }

        finishStart = ready
        active.on('authenticated', () => {
          if (controller.signal.aborted) {
            return
          }
          authenticated = true
          replaced = false
          host.connection('connected')
          ready()
        })
        active.on('error', () => {
          host.connection('degraded', 'sdk_connection_error')
          ready()
        })
        active.connect()
      })
    },
    async stop() {
      releaseSignal?.()
      releaseSignal = undefined
      controller.abort()
      client?.disconnect()
      finishStart?.()
      authenticated = false
      host.connection('disconnected')
    },
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
      if (!authenticated || !client || controller.signal.aborted) {
        return {
          status: 'retryable',
          errorCode: 'not_connected',
          retryAfterMs: 1000
        }
      }
      if (input.reply && !target.data.callbackReqId) {
        return { status: 'rejected', errorCode: 'reply_context_unavailable' }
      }

      const content = input.chunk.text

      if (Buffer.byteLength(content) > 20 * 1024) {
        return { status: 'rejected', errorCode: 'text_too_long' }
      }
      let transmitting = false
      try {
        if (input.chunk.media && !input.media) {
          return { status: 'rejected', errorCode: 'missing_media' }
        }

        input.signal.throwIfAborted()

        const mediaId = input.media
          ? await uploadResource(input.media, client)
          : undefined

        input.signal.throwIfAborted()
        controller.signal.throwIfAborted()
        const id = input.reply ? target.data.callbackReqId : undefined
        transmitting = true

        const response = id
          ? await client.reply(
              { headers: { req_id: id } },
              replyBody(input, mediaId)
            )
          : await client.sendMessage(input.target.chatId, {
              ...outgoingBody(input.media, mediaId, content)
            })

        return socketOutcome(response)
      } catch (error) {
        return (
          nativeFailure(error) ??
          (transmitting
            ? { status: 'unknown', errorCode: 'transport_uncertain' }
            : uploadFailure(error))
        )
      }
    }
  }
}

function replyBody(input: SendInput, mediaId: string | undefined): object {
  if (input.media) {
    return outgoingBody(input.media, mediaId, input.chunk.text)
  }
  // A completed native reply uses the stream envelope without incremental updates.
  // https://github.com/WecomTeam/aibot-node-sdk/blob/80615b987ef69c6028ad764924609247c0725955/src/client.ts#L178
  return {
    msgtype: 'stream',
    stream: {
      id: input.chunk.idempotencyKey,
      finish: true,
      content: input.chunk.text
    }
  }
}
