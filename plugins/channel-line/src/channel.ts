import { apiBase } from './constants.js'
import { randomUUID } from 'node:crypto'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import type { z } from 'zod'
import { lineClient, sdkFailure, validateSignature } from './sdk.js'
import { validateConfig, platformIdSchema } from './config.js'
import type { LineConfig } from './config.js'
import { receiveEvent } from './inbound.js'
import { mediaError, messages, splitLineMarkdown } from './media.js'
import { parseBody, rawBody, secret } from './io.js'
import { webhookSchema, targetSchema, retrySchema } from './schemas.js'

async function retryIdentity(
  host: ChannelHost,
  key: string
): Promise<z.infer<typeof retrySchema>> {
  const stateKey = `push:${key}`
  const previous = await host.state.get(stateKey)
  if (previous) {
    return retrySchema.parse(previous.value)
  }
  const value = { retryKey: randomUUID(), startedAt: Date.now() }

  const result = await host.state.compareAndSet({
    key: stateKey,
    expectedVersion: null,
    value
  })

  if (result.status === 'updated') {
    return value
  }
  const winner = await host.state.get(stateKey)
  if (!winner) {
    throw new Error('retry_identity_conflict')
  }
  return retrySchema.parse(winner.value)
}

export function createLineChannel(): ChannelPlugin<LineConfig> {
  let runtime:
    | {
        host: ChannelHost
        account: AccountConfig
        config: LineConfig
        botUserId: string
      }
    | undefined

  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== 'line'
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const { host, config } = runtime
    const parsed = targetSchema.safeParse(input.target.data)
    if (
      !parsed.success ||
      parsed.data.destination !== input.target.chatId ||
      parsed.data.botId !== runtime.botUserId ||
      parsed.data.apiBaseUrl !== new URL(apiBase).toString().replace(/\/$/u, '')
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const target = parsed.data
    const errorCode = mediaError(input, host)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }
    const retry = await retryIdentity(host, input.chunk.idempotencyKey)
    if (Date.now() - retry.startedAt >= 86_400_000) {
      return { status: 'unknown', errorCode: 'retry_key_expired' }
    }

    const outgoing = await messages(input, host, target.quoteToken).catch(
      (error: unknown): SendResult => {
        if (
          error instanceof Error &&
          error.message === 'rich_message_limit_exceeded'
        ) {
          return { status: 'rejected', errorCode: error.message }
        }
        return { status: 'retryable', errorCode: 'media_publication_failed' }
      }
    )

    if (!Array.isArray(outgoing)) {
      return outgoing
    }
    try {
      input.signal.throwIfAborted()

      const receipt = await lineClient(config).pushMessage(
        {
          to: target.destination,
          messages: outgoing
        },
        retry.retryKey
      )

      const first = receipt.sentMessages?.[0]
      return {
        status: 'sent',
        receipt: first ? { platformMessageId: first.id } : {}
      }
    } catch (error) {
      return sdkFailure(error)
    }
  }

  return {
    id: 'channel-line',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'line',
    get capabilities(): ChannelPlugin<LineConfig>['capabilities'] {
      return {
        receive: true,
        transport: 'http',
        maxTextLength: 5000,
        lengthUnit: 'utf16',
        idempotentSend: false,
        ...(runtime?.host.publicUrl && runtime.host.media
          ? {
              richText: {
                maxParts: 20,
                maxTextLength: 2000,
                imageMimeTypes: ['image/jpeg', 'image/png'],
                maxImageBytes: Math.min(
                  runtime.host.maxMediaBytes ?? 100 * 1024 * 1024,
                  10 * 1000 * 1000
                )
              }
            }
          : {}),
        media: {
          receive: ['image', 'audio', 'video', 'file'],
          send: ['image', 'audio', 'video']
        }
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      if (
        !runtime ||
        address.platform !== 'line' ||
        address.accountId !== runtime.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const prior = targetSchema.safeParse(learned?.data)

      const sameConversation =
        learned?.channel === 'line' &&
        learned.accountId === address.accountId &&
        learned.chatId === address.chatId &&
        learned.threadId === undefined &&
        prior.success &&
        prior.data.destination === address.chatId &&
        prior.data.botId === runtime.botUserId &&
        prior.data.apiBaseUrl ===
          new URL(apiBase).toString().replace(/\/$/u, '')

      return {
        status: 'available',
        target: {
          channel: 'line',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(sameConversation && learned.replyToId
            ? { replyToId: learned.replyToId }
            : {}),
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          data: {
            destination: address.chatId,
            ...(sameConversation && prior.data.quoteToken
              ? { quoteToken: prior.data.quoteToken }
              : {}),
            botId: runtime.botUserId,
            apiBaseUrl: new URL(apiBase).toString().replace(/\/$/u, '')
          }
        }
      }
    },

    splitText: splitLineMarkdown,
    async setup(host, account, config) {
      if (runtime) {
        throw new Error('already_setup')
      }

      const identity = await lineClient(config).getBotInfo()
      platformIdSchema.parse(identity.userId)
      const botUserId = identity.userId
      runtime = { host, account, config, botUserId }
      host.mountHttp('/webhook', async (incoming) => {
        if (incoming.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const body = await rawBody(incoming)
        if (
          !validateSignature(
            Buffer.from(body),
            secret(config.channelSecret),
            incoming.headers.get('x-line-signature') ?? ''
          )
        ) {
          return new Response(null, { status: 401 })
        }
        const decoded = webhookSchema.safeParse(parseBody(body))
        if (!decoded.success) {
          return new Response(null, { status: 400 })
        }
        if (decoded.data.destination !== botUserId) {
          return new Response(null, { status: 403 })
        }
        for (const event of decoded.data.events) {
          await receiveEvent(host, account, config, botUserId, event)
        }
        return Response.json({})
      })
    },
    send
  }
}
