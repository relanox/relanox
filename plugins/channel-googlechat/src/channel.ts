import { richError, richCapabilities } from './rich.js'
import { apiBase } from './constants.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  ChannelAddress,
  ReplyTarget,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { validatePublicUrl } from '@relanox/sdk'
import { chatClient, chatVerifier, sendFailure } from './sdk.js'
import type { chat_v1 } from './sdk.js'
import { validateConfig, platformIdSchema } from './config.js'
import type { GoogleChatConfig } from './config.js'
import { mediaCards } from './media.js'
import { receive } from './inbound.js'
import { parseBody, rawBody, secret } from './io.js'
import { serviceSchema, eventSchema, targetSchema } from './schemas.js'

function sourceQuote(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  clientEmail: string
): ReturnType<typeof targetSchema.parse>['quotedMessageMetadata'] {
  const source = targetSchema.safeParse(learned?.data)
  if (
    learned?.channel !== 'googlechat' ||
    learned.accountId !== address.accountId ||
    learned.chatId !== address.chatId ||
    learned.threadId !== address.threadId ||
    !source.success ||
    source.data.space !== address.chatId ||
    source.data.thread !== address.threadId ||
    source.data.scope.clientEmail !== clientEmail ||
    source.data.scope.apiBase !== new URL(apiBase).href ||
    source.data.quotedMessageMetadata?.name !== learned.replyToId ||
    !learned.replyToId?.startsWith(`${address.chatId}/messages/`)
  ) {
    return undefined
  }
  return source.data.quotedMessageMetadata
}

function messagePayload(
  input: SendInput,
  target: ReturnType<typeof targetSchema.parse>,
  cardsV2: Awaited<ReturnType<typeof mediaCards>>
): chat_v1.Schema$Message {
  return {
    ...(input.chunk.text
      ? { text: input.chunk.text, markupSyntax: 'MARKUP_SYNTAX_MARKDOWN' }
      : {}),
    ...(cardsV2 ? { cardsV2 } : {}),
    ...(input.reply && target.quotedMessageMetadata
      ? { quotedMessageMetadata: target.quotedMessageMetadata }
      : {}),
    ...(target.thread ? { thread: { name: target.thread } } : {})
  }
}

export function createGoogleChatChannel(): ChannelPlugin<GoogleChatConfig> {
  let runtime:
    | { host: ChannelHost; account: AccountConfig; config: GoogleChatConfig }
    | undefined

  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== 'googlechat'
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const { config } = runtime
    const parsed = targetSchema.safeParse(input.target.data)
    if (!parsed.success) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const target = parsed.data
    if (
      target.space !== input.target.chatId ||
      target.thread !== input.target.threadId
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    let clientEmail: string
    try {
      clientEmail = serviceSchema.parse(
        JSON.parse(secret(config.serviceAccount)) as unknown
      ).client_email
    } catch {
      return { status: 'retryable', errorCode: 'oauth_unavailable' }
    }
    if (
      target.scope.clientEmail !== clientEmail ||
      target.scope.apiBase !== new URL(apiBase).href
    ) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
    }
    if (input.reply && !target.quotedMessageMetadata) {
      return { status: 'rejected', errorCode: 'reply_context_unavailable' }
    }
    const errorCode = richError(input)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }
    let cardsV2: Awaited<ReturnType<typeof mediaCards>>
    try {
      cardsV2 = await mediaCards(input, runtime.host)
    } catch (error) {
      return preparationFailure(error)
    }
    let started = false
    try {
      const response = await chatClient(config).spaces.messages.create(
        {
          parent: target.space,
          ...(target.thread
            ? { messageReplyOption: 'REPLY_MESSAGE_OR_FAIL' }
            : {}),
          requestBody: messagePayload(input, target, cardsV2)
        },
        {
          signal: input.signal,
          // Observe the actual SDK API dispatch, after authentication. A failed
          // Or canceled call after this point must not become a blind retry.
          fetchImplementation: async (url, init): Promise<Response> => {
            started = true
            return fetch(url, init)
          }
        }
      )

      return {
        status: 'sent',
        receipt: {
          platformMessageId: platformIdSchema.parse(response.data.name)
        }
      }
    } catch (error) {
      return sendFailure(config, error, started)
    }
  }

  return {
    id: 'channel-googlechat',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'googlechat',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 30_000,
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
        !runtime ||
        address.platform !== 'googlechat' ||
        address.accountId !== runtime.account.id
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      let clientEmail: string
      try {
        clientEmail = serviceSchema.parse(
          JSON.parse(secret(runtime.config.serviceAccount)) as unknown
        ).client_email
      } catch {
        return { status: 'unavailable', reason: 'oauth_unavailable' }
      }

      const quotedMessageMetadata = sourceQuote(address, learned, clientEmail)

      const destination = {
        space: address.chatId,
        ...(address.threadId !== undefined ? { thread: address.threadId } : {}),
        ...(quotedMessageMetadata ? { quotedMessageMetadata } : {}),
        scope: { clientEmail, apiBase: new URL(apiBase).href }
      }

      const data = targetSchema.safeParse(destination)
      if (
        !data.success ||
        (address.threadId !== undefined &&
          !address.threadId.startsWith(`${address.chatId}/threads/`))
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      return {
        status: 'available',
        target: {
          channel: 'googlechat',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          ...(quotedMessageMetadata
            ? { replyToId: quotedMessageMetadata.name }
            : {}),
          data: destination
        }
      }
    },
    async setup(host, account, config) {
      if (host.publicUrl === undefined) {
        throw new Error('public_url_required')
      }
      const audience = `${validatePublicUrl(host.publicUrl)}/channels/${account.id}/webhook`
      runtime = { host, account, config }

      const verifier = chatVerifier()

      host.mountHttp('/webhook', async (incoming) => {
        if (incoming.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const authorization = incoming.headers.get('authorization')
        if (!authorization?.startsWith('Bearer ')) {
          return new Response(null, { status: 401 })
        }
        try {
          const ticket = await verifier.verifyIdToken({
            idToken: authorization.slice(7),
            audience
          })

          const payload = ticket.getPayload()

          if (
            payload?.email !== 'chat@system.gserviceaccount.com' ||
            payload.email_verified !== true
          ) {
            return new Response(null, { status: 401 })
          }
        } catch {
          return new Response(null, { status: 401 })
        }
        const event = eventSchema.safeParse(parseBody(await rawBody(incoming)))
        if (!event.success) {
          return new Response(null, { status: 400 })
        }
        await receive(host, account, event.data, config)
        return Response.json({})
      })
    },
    send
  }
}

function preparationFailure(error: unknown): SendResult {
  if (
    error instanceof Error &&
    [
      'media_publication_unavailable',
      'invalid_publication_url',
      'rich_text_limit_exceeded'
    ].includes(error.message)
  ) {
    return { status: 'rejected', errorCode: error.message }
  }
  return { status: 'retryable', errorCode: 'media_preparation_unavailable' }
}
