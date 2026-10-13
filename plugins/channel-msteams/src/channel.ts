import { jwksUrl } from './constants.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
  ChannelAddress,
  ReplyTarget
} from '@relanox/sdk'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { accessToken, serviceUrl } from './client.js'
import {
  validateConfig,
  validateEndpointUrl,
  platformIdSchema
} from './config.js'
import type { TeamsConfig } from './config.js'
import type { z } from 'zod'
import {
  prepareAttachment,
  consentPosted,
  consentThrottled,
  richAttachment,
  richPreparationFailure,
  richError,
  richCapabilities
} from './media.js'
import { receive } from './inbound.js'
import { failure, parseBody, rawBody, request, unavailable } from './io.js'
import {
  activitySchema,
  targetSchema,
  keysSchema,
  receiptSchema
} from './schemas.js'

function matchesTarget(
  target: z.infer<typeof targetSchema>,
  input: SendInput,
  config: TeamsConfig
): boolean {
  return (
    target.appId === config.appId &&
    target.conversationId === input.target.chatId &&
    target.tenantId === config.tenantId &&
    target.botId === config.botId &&
    (input.target.threadId === undefined ||
      target.replyToId === input.target.threadId)
  )
}

function currentConversation(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  config: TeamsConfig
): boolean {
  const parsed = targetSchema.safeParse(learned?.data)
  return (
    learned?.channel === 'msteams' &&
    learned.accountId === address.accountId &&
    learned.chatId === address.chatId &&
    learned.threadId === address.threadId &&
    parsed.success &&
    parsed.data.appId === config.appId &&
    parsed.data.tenantId === config.tenantId &&
    parsed.data.botId === config.botId &&
    parsed.data.conversationId === address.chatId
  )
}

function conversationKey(config: TeamsConfig, chatId: string): string {
  return `conversation:${JSON.stringify([config.appId, config.tenantId, config.botId, chatId])}`
}

async function learnConversation(
  host: ChannelHost,
  config: TeamsConfig,
  activity: z.infer<typeof activitySchema>
): Promise<void> {
  const key = conversationKey(config, activity.conversation.id)

  const data = {
    appId: config.appId,
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    tenantId: config.tenantId,
    botId: config.botId,
    userId: activity.from.id,
    ...(activity.conversation.conversationType
      ? { personal: activity.conversation.conversationType === 'personal' }
      : {})
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previous = await host.state.get(key)

    const result = await host.state.compareAndSet({
      key,
      expectedVersion: previous?.version ?? null,
      value: data
    })

    if (result.status === 'updated') {
      return
    }
  }
  throw new Error('conversation_state_conflict')
}

async function sendFailure(
  host: ChannelHost,
  response: Response,
  consentKey: string | undefined
): Promise<SendResult> {
  if (consentKey && response.status === 429) {
    await consentThrottled(host, consentKey)
  }
  return failure(response)
}

export function createTeamsChannel(): ChannelPlugin<TeamsConfig> {
  let runtime:
    | { host: ChannelHost; account: AccountConfig; config: TeamsConfig }
    | undefined

  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== 'msteams'
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const { config } = runtime
    const parsed = targetSchema.safeParse(input.target.data)
    if (!parsed.success) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const target = parsed.data
    if (!matchesTarget(target, input, config)) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    let base: URL
    try {
      base = serviceUrl(target.serviceUrl, config)
    } catch {
      return { status: 'rejected', errorCode: 'untrusted_service_origin' }
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
    let rich: Awaited<ReturnType<typeof richAttachment>>
    let prepared: Awaited<ReturnType<typeof prepareAttachment>>
    try {
      rich = await richAttachment(input, runtime.host)
      prepared = await prepareAttachment(
        runtime.host,
        config,
        input,
        {
          conversationId: target.conversationId,
          userId: target.userId,
          botId: target.botId
        },
        target.personal === true
      )
    } catch (error) {
      return richPreparationFailure(error)
    }
    if (prepared.outcome) {
      return prepared.outcome
    }
    try {
      const suffix = target.replyToId
        ? `/${encodeURIComponent(target.replyToId)}`
        : ''

      const url = new URL(
        `${base.href.replace(/\/$/u, '')}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities${suffix}`
      )

      const response = await request(
        url,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            type: 'message',
            textFormat: 'extendedmarkdown',
            text: input.chunk.text,
            ...((rich ?? prepared.attachment) !== undefined
              ? { attachments: [rich ?? prepared.attachment] }
              : {}),
            channelId: 'msteams',
            from: { id: target.botId },
            recipient: { id: target.userId },
            conversation: {
              id: target.conversationId,
              tenantId: target.tenantId
            },
            ...(target.replyToId ? { replyToId: target.replyToId } : {}),
            channelData: { tenant: { id: target.tenantId } }
          })
        },
        input.signal
      )

      if (!response.ok) {
        return await sendFailure(runtime.host, response, prepared.consentKey)
      }
      if (prepared.consentKey) {
        await consentPosted(runtime.host, prepared.consentKey)
        return {
          status: 'pending',
          retryAfterMs: 30_000
        }
      }
      return {
        status: 'sent',
        receipt: {
          platformMessageId: receiptSchema.parse(await response.json()).id
        }
      }
    } catch {
      return unavailable()
    }
  }

  return {
    id: 'channel-msteams',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'msteams',
    get capabilities(): ChannelPlugin<TeamsConfig>['capabilities'] {
      return {
        receive: true,
        transport: 'http',
        maxTextLength: 12_000,
        ...(runtime?.host.publicUrl?.startsWith('https://')
          ? { richText: richCapabilities }
          : {}),
        lengthUnit: 'utf16',
        idempotentSend: false,
        media: {
          receive: ['image', 'audio', 'video', 'file'],
          send: ['image', 'audio', 'video', 'file']
        }
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      if (
        !runtime ||
        address.platform !== 'msteams' ||
        address.accountId !== runtime.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        (address.threadId !== undefined &&
          !platformIdSchema.safeParse(address.threadId).success)
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const { host, config } = runtime

      let parsed = targetSchema.safeParse(learned?.data)
      if (!currentConversation(address, learned, config)) {
        parsed = targetSchema.safeParse(
          (await host.state.get(conversationKey(config, address.chatId)))?.value
        )
      }
      if (!parsed.success) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }
      const data = parsed.data
      if (
        data.appId !== config.appId ||
        data.tenantId !== config.tenantId ||
        data.botId !== config.botId ||
        data.conversationId !== address.chatId
      ) {
        return { status: 'unavailable', reason: 'target_identity_changed' }
      }
      try {
        serviceUrl(data.serviceUrl, config)
      } catch {
        return { status: 'unavailable', reason: 'untrusted_service_origin' }
      }

      const destination = {
        appId: data.appId,
        serviceUrl: data.serviceUrl,
        conversationId: data.conversationId,
        tenantId: data.tenantId,
        botId: data.botId,
        userId: data.userId,
        ...(data.personal !== undefined ? { personal: data.personal } : {})
      }

      return {
        status: 'available',
        target: {
          channel: 'msteams',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          data: {
            ...destination,
            ...(address.threadId !== undefined
              ? { replyToId: address.threadId }
              : {})
          }
        }
      }
    },
    async setup(host, account, config) {
      runtime = { host, account, config }

      const keys = createRemoteJWKSet(validateEndpointUrl(jwksUrl), {
        timeoutDuration: 5000,
        cacheMaxAge: 3_600_000
      })

      host.mountHttp('/activities', async (incoming) => {
        if (incoming.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const authorization = incoming.headers.get('authorization')
        if (!authorization?.startsWith('Bearer ')) {
          return new Response(null, { status: 401 })
        }

        const decoded = activitySchema.safeParse(
          parseBody(await rawBody(incoming))
        )

        if (!decoded.success) {
          return new Response(null, { status: 400 })
        }
        const activity = decoded.data
        try {
          const verified = await jwtVerify(authorization.slice(7), keys, {
            algorithms: ['RS256'],
            issuer: 'https://api.botframework.com',
            audience: config.appId,
            requiredClaims: ['exp', 'nbf']
          })

          const jwks = keysSchema.parse(keys.jwks())

          const signingKey = jwks.keys.find(
            (key) => key.kid === verified.protectedHeader.kid
          )

          if (!signingKey?.endorsements?.includes('msteams')) {
            return new Response(null, { status: 403 })
          }
          if (
            verified.payload.serviceurl !== activity.serviceUrl &&
            verified.payload.serviceUrl !== activity.serviceUrl
          ) {
            return new Response(null, { status: 403 })
          }
          serviceUrl(activity.serviceUrl, config)
        } catch {
          return new Response(null, { status: 401 })
        }
        if (
          activity.channelId !== 'msteams' ||
          activity.recipient.id !== config.botId ||
          activity.channelData.tenant.id !== config.tenantId ||
          (activity.conversation.tenantId &&
            activity.conversation.tenantId !== config.tenantId)
        ) {
          return new Response(null, { status: 403 })
        }
        if (
          account.allowedSenders.includes(activity.from.id) &&
          ['message', 'conversationUpdate', 'installationUpdate'].includes(
            activity.type
          )
        ) {
          await learnConversation(host, config, activity)
        }
        await receive(host, account, config, activity)
        return Response.json({})
      })
    },
    send
  }
}
