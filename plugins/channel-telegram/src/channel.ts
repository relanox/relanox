import type { AccountConfig, ChannelHost, ChannelPlugin } from '@relanox/sdk'
import type { z } from 'zod'
import { sendOutcome } from './client.js'
import { validateConfig } from './config.js'
import type { TelegramConfig } from './config.js'
import { targetSchema, updateSchema } from './schemas.js'
import { bytes, credential, equal, ingest, postJson } from './transport.js'
import { hasMedia, receiveMedia, sendMedia } from './media.js'

/** One factory instance per configured account. Credentials are resolved only at use. */
export function createTelegramChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<TelegramConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: TelegramConfig

  const identity = () => ({
    botId: credential(config.botToken, environment).split(':')[0] ?? '',
    apiBaseUrl: new URL(config.apiBaseUrl).toString().replace(/\/$/u, '')
  })

  return {
    id: 'channel-telegram',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'telegram',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 4096,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = nextConfig
      if (
        !/^\d+:[A-Za-z0-9_-]+$/u.test(credential(config.botToken, environment))
      ) {
        throw new Error('invalid_bot_token')
      }
      if (
        !/^[A-Za-z0-9_-]{1,256}$/u.test(
          credential(config.webhookSecret, environment)
        )
      ) {
        throw new Error('invalid_webhook_secret')
      }
      host.mountHttp('/webhook', async (request) => {
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        if (
          !equal(
            request.headers.get('x-telegram-bot-api-secret-token') ?? '',
            credential(config.webhookSecret, environment)
          )
        ) {
          return new Response(null, { status: 401 })
        }
        let raw: Buffer
        try {
          raw = await bytes(request)
        } catch {
          return new Response(null, { status: 413 })
        }
        let update: z.infer<typeof updateSchema>
        try {
          update = updateSchema.parse(JSON.parse(raw.toString('utf8')))
        } catch {
          return new Response(null, { status: 400 })
        }
        const message = update.message
        if (
          !message ||
          (!message.text && !hasMedia(message)) ||
          !message.from ||
          message.from.is_bot ||
          message.chat.type === 'channel'
        ) {
          host.observe.count('relanox_inbound_total', {
            channel: 'telegram',
            operation: 'ingest',
            outcome: 'rejected',
            error_class: 'unsupported'
          })
          return new Response(null, { status: 204 })
        }
        try {
          await ingest(host, {
            source: {
              channel: 'telegram',
              accountId: account.id,
              eventId: String(update.update_id)
            },
            senderId: String(message.from.id),
            text: message.text ?? message.caption ?? '',
            attachments: await receiveMedia(
              message,
              host,
              config,
              credential(config.botToken, environment)
            ),
            target: {
              channel: 'telegram',
              accountId: account.id,
              chatId: String(message.chat.id),
              ...(message.message_thread_id
                ? { threadId: String(message.message_thread_id) }
                : {}),
              replyToId: String(message.message_id),
              data: identity()
            },
            receivedAt: Date.now(),
            context: { messageId: String(message.message_id) }
          })
          return new Response(null, { status: 204 })
        } catch {
          return new Response(null, { status: 503 })
        }
      })
    },
    async send(input) {
      const data = targetSchema.safeParse(input.target.data)
      const current = identity()
      if (
        !data.success ||
        data.data.botId !== current.botId ||
        data.data.apiBaseUrl !== current.apiBaseUrl ||
        input.target.accountId !== account.id ||
        input.target.channel !== 'telegram' ||
        !/^-?\d+$/u.test(input.target.chatId) ||
        (input.target.threadId && !/^\d+$/u.test(input.target.threadId)) ||
        (input.target.replyToId && !/^\d+$/u.test(input.target.replyToId))
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      try {
        const token = credential(config.botToken, environment)
        if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token)) {
          return { status: 'rejected', errorCode: 'invalid_bot_token' }
        }
        if (input.chunk.media) {
          return await sendMedia(input, host, config, token)
        }

        const response = await postJson(
          `${config.apiBaseUrl.replace(/\/$/u, '')}/bot${token}/sendMessage`,
          {},
          {
            chat_id: input.target.chatId,
            text: input.chunk.text,
            ...(input.target.threadId
              ? { message_thread_id: Number(input.target.threadId) }
              : {}),
            ...(input.target.replyToId
              ? {
                  reply_parameters: {
                    message_id: Number(input.target.replyToId),
                    allow_sending_without_reply: true
                  }
                }
              : {}),
            link_preview_options: { is_disabled: true }
          },
          input.signal,
          config.timeoutMs
        )

        return await sendOutcome(response)
      } catch {
        return { status: 'unknown', errorCode: 'telegram_transport_error' }
      }
    }
  }
}
