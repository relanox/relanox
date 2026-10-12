import { richError, richCapabilities } from './rich.js'
import { apiBase, jwksUrl } from './constants.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { validatePublicUrl } from '@relanox/sdk'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { accessToken } from './client.js'
import { validateConfig } from './config.js'
import type { GoogleChatConfig } from './config.js'
import { mediaCards } from './media.js'
import { receive } from './inbound.js'
import {
  failure,
  parseBody,
  rawBody,
  request,
  secret,
  unavailable
} from './io.js'
import {
  serviceSchema,
  eventSchema,
  targetSchema,
  receiptSchema
} from './schemas.js'

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
    const errorCode = richError(input, runtime.host)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }
    let token: string | SendResult
    try {
      token = await accessToken(config, input.signal)
    } catch {
      return { status: 'retryable', errorCode: 'oauth_unavailable' }
    }
    if (typeof token !== 'string') {
      return token
    }
    let cardsV2: Awaited<ReturnType<typeof mediaCards>>
    try {
      cardsV2 = await mediaCards(input, runtime.host)
    } catch (error) {
      return preparationFailure(error)
    }
    try {
      const url = new URL(`${apiBase}/v1/${target.space}/messages`)

      if (target.thread) {
        url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_OR_FAIL')
      }

      const response = await request(
        url,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            ...(input.chunk.text
              ? {
                  text: input.chunk.text,
                  markupSyntax: 'MARKUP_SYNTAX_MARKDOWN'
                }
              : {}),
            ...(cardsV2 ? { cardsV2 } : {}),
            ...(target.thread ? { thread: { name: target.thread } } : {})
          })
        },
        input.signal
      )

      if (!response.ok) {
        return failure(response)
      }
      return {
        status: 'sent',
        receipt: {
          platformMessageId: receiptSchema.parse(await response.json()).name
        }
      }
    } catch {
      return unavailable()
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
    async resolveChannel(address) {
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

      const destination = {
        space: address.chatId,
        ...(address.threadId !== undefined ? { thread: address.threadId } : {}),
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

      const keys = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5000,
        cacheMaxAge: 3_600_000
      })

      host.mountHttp('/webhook', async (incoming) => {
        if (incoming.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const authorization = incoming.headers.get('authorization')
        if (!authorization?.startsWith('Bearer ')) {
          return new Response(null, { status: 401 })
        }
        try {
          const { payload } = await jwtVerify(authorization.slice(7), keys, {
            algorithms: ['RS256'],
            issuer: 'https://accounts.google.com',
            audience,
            requiredClaims: ['exp', 'iat', 'email', 'email_verified']
          })

          if (
            payload.email !== 'chat@system.gserviceaccount.com' ||
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
