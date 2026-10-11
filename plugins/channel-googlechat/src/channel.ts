import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { accessToken } from './client.js'
import { validateConfig, validateEndpointUrl } from './config.js'
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
      target.scope.apiBase !== new URL(config.apiBase).href
    ) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
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
      const url = validateEndpointUrl(
        `${config.apiBase}/v1/${target.space}/messages`,
        config.allowLoopback
      )

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
            ...(input.chunk.text ? { text: input.chunk.text } : {}),
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
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async setup(host, account, config) {
      runtime = { host, account, config }

      const keys = createRemoteJWKSet(
        validateEndpointUrl(config.jwksUrl, config.allowLoopback),
        {
          timeoutDuration: 5000,
          cacheMaxAge: 3_600_000
        }
      )

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
            audience: config.audience,
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
    error.message === 'media_publication_unavailable'
  ) {
    return { status: 'rejected', errorCode: 'media_publication_unavailable' }
  }
  return { status: 'retryable', errorCode: 'media_preparation_unavailable' }
}
