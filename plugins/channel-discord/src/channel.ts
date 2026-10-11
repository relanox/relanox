import { discoverIdentity } from './identity.js'
import type { AccountConfig, ChannelHost, ChannelPlugin } from '@relanox/sdk'
import { validateConfig, API_BASE_URL } from './config.js'
import type { DiscordConfig } from './config.js'
import { sendMessage, mediaError } from './media.js'
import type { DiscordGateway } from './gateway.js'
import { createDiscordGateway } from './gateway.js'
import {
  sendResponseSchema,
  rateLimitResponseSchema,
  targetSchema
} from './schemas.js'
import { credential, failure, jsonResponse } from './transport.js'

export function createDiscordChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<DiscordConfig> {
  let config: DiscordConfig
  let botUserId: string
  let host: ChannelHost
  let account: AccountConfig
  let gateway: DiscordGateway

  const identity = (): { botId: string; apiBaseUrl: string } => ({
    botId: botUserId,
    apiBaseUrl: new URL(API_BASE_URL).toString().replace(/\/$/u, '')
  })

  return {
    id: 'channel-discord',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'discord',
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 2000,
      lengthUnit: 'utf16',
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

      const discovered = await discoverIdentity(
        credential(config.botToken, environment)
      )

      botUserId = discovered.botId
      gateway = createDiscordGateway(
        config,
        discovered,
        host,
        account,
        environment
      )
    },
    async start(signal) {
      await gateway.start(signal)
    },
    async stop() {
      await gateway.stop()
    },
    async send(input) {
      const data = targetSchema.safeParse(input.target.data)
      const current = identity()
      if (
        !data.success ||
        data.data.botId !== current.botId ||
        data.data.apiBaseUrl !== current.apiBaseUrl ||
        input.target.channel !== 'discord' ||
        input.target.accountId !== account.id ||
        !/^\d+$/u.test(input.target.chatId) ||
        (input.target.threadId && !/^\d+$/u.test(input.target.threadId)) ||
        (input.target.replyToId && !/^\d+$/u.test(input.target.replyToId))
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      try {
        const errorCode = mediaError(input, host)
        if (errorCode) {
          return { status: 'rejected', errorCode }
        }

        const response = await sendMessage(
          input,
          host,
          config,
          credential(config.botToken, environment)
        )

        if (response.status === 429) {
          const parsed = rateLimitResponseSchema.safeParse(
            await jsonResponse(response).catch(() => null)
          )

          return {
            status: 'retryable',
            errorCode: 'rate_limited',
            ...(parsed.success
              ? { retryAfterMs: Math.ceil(parsed.data.retry_after * 1000) }
              : {})
          }
        }
        if (!response.ok) {
          return failure(response)
        }

        const parsed = sendResponseSchema.safeParse(
          await jsonResponse(response)
        )

        return parsed.success
          ? { status: 'sent', receipt: { platformMessageId: parsed.data.id } }
          : { status: 'unknown', errorCode: 'invalid_platform_response' }
      } catch {
        return { status: 'unknown', errorCode: 'discord_transport_error' }
      }
    }
  }
}
