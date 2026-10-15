import {
  QQBot,
  GatewayError,
  concurrencyGuard
} from '@tencent-connect/qqbot-nodejs'
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs'
import { apiBase, configSchema, MAX_RECONNECT_ATTEMPTS } from './config.js'
import { downloadAttachments } from './media.js'
import { apiError, sdkFailure } from './api-error.js'
import { uploadMedia } from './upload.js'
import { richCapabilities, richError, richMarkdown } from './rich.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
  ChannelAddress,
  ReplyTarget
} from '@relanox/sdk'
import type { z } from 'zod'
import type { QqConfig } from './config.js'
import { sendResponseSchema, messageSchema, targetSchema } from './schemas.js'
import { ingestText, secret } from './bridge.js'

function learnedTarget(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  config: QqConfig
): z.infer<typeof targetSchema> | undefined {
  const prior = targetSchema.safeParse(learned?.data)
  if (
    learned?.channel !== 'qq' ||
    learned.accountId !== address.accountId ||
    learned.chatId !== address.chatId ||
    learned.threadId !== undefined ||
    !prior.success ||
    prior.data.scope.appId !== config.appId ||
    prior.data.scope.apiBase !== new URL(apiBase(config)).href
  ) {
    return undefined
  }
  return prior.data
}

function configuredType(
  types: QqConfig['recipientTypes'],
  chatId: string
): 'c2c' | 'group' | undefined {
  return types && Object.hasOwn(types, chatId) ? types[chatId] : undefined
}

function supportedMessage(message: z.infer<typeof messageSchema>): boolean {
  return !(
    (message.msgType !== undefined && ![0, 7, 103].includes(message.msgType)) ||
    (!message.attachments?.length && !message.content.trim())
  )
}

export function createQqChannel(): ChannelPlugin<QqConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: QqConfig
  let bot: QQBot
  let controller = new AbortController()
  let receiveSignal = controller.signal
  let running: Promise<void> | undefined
  const inbound = new Set<Promise<void>>()

  async function ingestMessage(input: QQBotInboundMessage): Promise<void> {
    receiveSignal.throwIfAborted()
    const message = messageSchema.parse(input)
    if (message.senderIsBot || message.raw.author.bot) {
      return
    }
    if (!supportedMessage(message)) {
      host.observe.log('info', 'channel_unsupported_input', {
        errorCode: 'unsupported_message_type'
      })
      return
    }
    const { senderId, replyTarget } = message
    const chatId = replyTarget.targetId

    if (!account.allowedSenders.includes(senderId)) {
      host.observe.log('info', 'channel_input_discarded', {
        errorCode: 'sender_not_allowed'
      })
      return
    }

    // Use SDK-normalized part indices; retain the native sequence when no index exists.
    const eventId = JSON.stringify([
      message.rawEventType,
      message.messageId,
      message.msgIdx ?? message.raw.msg_seq ?? null
    ])

    const attachments = await downloadAttachments(
      message.attachments ?? [],
      host,
      receiveSignal
    )

    await ingestText(host, {
      source: { channel: 'qq', accountId: account.id, eventId },
      senderId,
      text: [message.content, ...attachments.fallbacks]
        .filter(Boolean)
        .join('\n'),
      attachments: attachments.uploads,
      target: {
        channel: 'qq',
        accountId: account.id,
        chatId,
        replyToId: message.messageId,
        data: {
          type: replyTarget.scope,
          msgId: replyTarget.msgId,
          ...(message.msgIdx ? { msgIdx: message.msgIdx } : {}),
          messageAt: Date.parse(message.timestamp),
          scope: { appId: config.appId, apiBase: new URL(apiBase(config)).href }
        }
      },
      receivedAt: Date.now(),
      context:
        attachments.remoteImages.length > 0
          ? { remoteImages: attachments.remoteImages }
          : null
    })
  }

  function replyMode(
    target: z.infer<typeof targetSchema>
  ): 'passive' | 'proactive' {
    if (
      target.messageAt !== undefined &&
      Date.now() <
        target.messageAt + (target.type === 'c2c' ? 3_600_000 : 300_000)
    ) {
      return 'passive'
    }
    return 'proactive'
  }

  async function transmit(
    input: SendInput,
    target: z.infer<typeof targetSchema>
  ): Promise<SendResult> {
    let transmitting = false
    try {
      input.signal.throwIfAborted()
      let mode = replyMode(target)

      const nativeTarget = {
        scope: target.type,
        targetId: encodeURIComponent(input.target.chatId),
        ...(mode === 'passive' && target.msgId !== undefined
          ? { msgId: target.msgId }
          : {})
      }

      input.signal.throwIfAborted()
      const media = await uploadMedia(input, nativeTarget, bot)
      if (typeof media !== 'string' && media !== undefined) {
        return media
      }
      const markdown = await richMarkdown(input, host)
      input.signal.throwIfAborted()
      // Uploads can outlive the passive reply window or the Core deadline.
      mode = replyMode(target)
      if (mode === 'proactive') {
        delete nativeTarget.msgId
      }
      transmitting = true

      const raw = await bot.send({
        target: nativeTarget,
        ...(input.reply && target.msgIdx
          ? { messageReference: { message_id: target.msgIdx } }
          : {}),
        ...(media
          ? {
              content: input.chunk.text,
              media: { file_info: media }
            }
          : { markdown: { content: markdown } })
      })

      const failure = apiError(raw)
      if (failure) {
        return failure
      }
      const response = sendResponseSchema.parse(raw)
      return { status: 'sent', receipt: { platformMessageId: response.id } }
    } catch (error) {
      return sdkFailure(error, transmitting)
    }
  }

  return {
    id: 'channel-qq',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'qq',
    get capabilities() {
      return {
        receive: true,
        transport: 'connection',
        maxTextLength: 2000,
        ...(host?.media && host.publicUrl?.startsWith('https://')
          ? { richText: richCapabilities }
          : {}),
        lengthUnit: 'utf8',
        idempotentSend: false,
        media: {
          receive: ['image', 'audio', 'video', 'file'],
          send: ['image', 'audio', 'video', 'file']
        }
      } as const
    },
    validateConfig: (value) => configSchema.parse(value),
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'qq' ||
        address.accountId !== account.id ||
        !address.chatId ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const known = learnedTarget(address, learned, config)

      const type =
        configuredType(config.recipientTypes, address.chatId) ?? known?.type

      if (!type) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }

      const data = {
        type,
        scope: { appId: config.appId, apiBase: new URL(apiBase(config)).href },
        ...(known?.type === type &&
        known.msgId !== undefined &&
        known.messageAt !== undefined
          ? {
              msgId: known.msgId,
              messageAt: known.messageAt,
              ...(known.msgIdx ? { msgIdx: known.msgIdx } : {})
            }
          : {})
      }

      return {
        status: 'available',
        target: {
          channel: 'qq',
          accountId: account.id,
          chatId: address.chatId,
          data
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = configSchema.parse(nextConfig)
      bot = new QQBot({
        appId: config.appId,
        appSecret: secret(config.clientSecret),
        accountId: account.id,
        baseUrl: apiBase(config),
        intents: 1 << 25,
        markdownSupport: true,
        reconnect: { maxAttempts: MAX_RECONNECT_ATTEMPTS }
      })
      bot.on('ready', () => {
        host.connection('connected')
      })
      bot.on('resumed', () => {
        host.connection('connected')
      })
      bot.on('disconnected', () => {
        host.connection('disconnected')
      })
      bot.on('error', () => {
        host.connection('degraded', 'qq_sdk_error')
      })
      // SDK stop closes the transport but does not await inbound processing.
      bot.use(async (_, proceed) => {
        const work = proceed()
        inbound.add(work)
        try {
          await work
        } finally {
          inbound.delete(work)
        }
      })
      // The SDK orders each conversation; do not discard input at its default queue limit.
      bot.use(concurrencyGuard({ strategy: 'queue', maxQueue: Infinity }))
      bot.on('message', async (_, message) =>
        ingestMessage(message).catch(() => {
          if (!receiveSignal.aborted) {
            host.observe.log('error', 'channel_ingest_failed', {
              errorCode: 'qq_input_failed'
            })
          }
        })
      )
    },
    async start(signal) {
      if (running) {
        return
      }
      controller = new AbortController()
      receiveSignal = AbortSignal.any([signal, controller.signal])
      running = bot
        .start(receiveSignal)
        .catch((error: unknown) => {
          host.connection(
            'degraded',
            error instanceof GatewayError ? error.code : 'qq_sdk_start_failed'
          )
        })
        .finally(() => {
          running = undefined
        })
    },
    async stop() {
      controller.abort()
      bot.stop()
      await running
      await Promise.all(inbound)
    },
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
      const invalid = richError(input, host)
      if (invalid) {
        return { status: 'rejected', errorCode: invalid }
      }
      if (
        input.chunk.richText &&
        (!host.media || !host.publicUrl?.startsWith('https://'))
      ) {
        return {
          status: 'rejected',
          errorCode: 'media_publication_unavailable'
        }
      }
      return transmit(input, target.data)
    }
  }
}
