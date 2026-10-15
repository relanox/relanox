import { MessageActivityInput } from '@microsoft/teams.api'
import type { Activity, Attachment } from '@microsoft/teams.api'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
  ChannelAddress,
  ReplyTarget
} from '@relanox/sdk'
import { TeamsClient, serviceUrl } from './native.js'
import { validateConfig, platformIdSchema } from './config.js'
import type { TeamsConfig } from './config.js'
import type { z } from 'zod'
import {
  prepareAttachment,
  consentPosted,
  consentPostRefused,
  richAttachment,
  richPreparationFailure,
  richError,
  richCapabilities
} from './media.js'
import { receive } from './inbound.js'
import { platformFailure } from './io.js'
import { targetSchema } from './schemas.js'

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
    (input.reply === undefined ||
      platformIdSchema.safeParse(input.target.replyToId).success) &&
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

function replyRoute(input: SendInput): string | undefined {
  return (
    input.target.threadId ?? (input.reply ? input.target.replyToId : undefined)
  )
}

function sourceReplyFields(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  config: TeamsConfig
): { replyToId?: string } {
  if (!learned || !currentConversation(address, learned, config)) {
    return {}
  }
  return learned.replyToId ? { replyToId: learned.replyToId } : {}
}

function conversationKey(config: TeamsConfig, chatId: string): string {
  return `conversation:${JSON.stringify([config.appId, config.tenantId, config.botId, chatId])}`
}

async function learnConversation(
  host: ChannelHost,
  config: TeamsConfig,
  activity: Activity
): Promise<void> {
  const key = conversationKey(config, activity.conversation.id)

  const data = {
    appId: config.appId,
    serviceUrl: activity.serviceUrl ?? '',
    conversationId: activity.conversation.id,
    tenantId: config.tenantId,
    botId: config.botId,
    userId: activity.from.id,
    ...(activity.conversation.conversationType !== undefined
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

function outboundMessage(
  input: SendInput,
  target: z.infer<typeof targetSchema>,
  attachment: Attachment | undefined
): MessageActivityInput {
  const route = replyRoute(input)

  const message = new MessageActivityInput(input.chunk.text, {
    textFormat: 'extendedmarkdown',
    channelId: 'msteams',
    from: { id: target.botId },
    recipient: { id: target.userId, role: 'user' },
    conversation: { id: target.conversationId, tenantId: target.tenantId },
    channelData: { tenant: { id: target.tenantId } }
  })

  if (input.reply && input.target.replyToId) {
    message.withText('').addQuote(input.target.replyToId, input.chunk.text)
  }
  if (route) {
    message.withReplyToId(route)
  }
  if (attachment) {
    message.addAttachments(attachment)
  }

  return message
}

export function createTeamsChannel(): ChannelPlugin<TeamsConfig> {
  let runtime:
    | {
        host: ChannelHost
        account: AccountConfig
        config: TeamsConfig
        client: TeamsClient
      }
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
    try {
      await runtime.client.accessToken()
    } catch (error) {
      return platformFailure(error, true)
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
      const route = replyRoute(input)

      const api = await runtime.client.api(base.href, input.signal)

      const message = outboundMessage(
        input,
        target,
        rich ?? prepared.attachment
      )

      const receipt = route
        ? await api.conversations.replyToActivity(
            target.conversationId,
            route,
            message
          )
        : await api.conversations.createActivity(target.conversationId, message)

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
          platformMessageId: platformIdSchema.parse(receipt.id)
        }
      }
    } catch (error) {
      const result = platformFailure(error)
      if (result.errorCode === 'oauth_token_rejected') {
        runtime.client.invalidate()
      }
      if (
        prepared.consentKey &&
        ['rate_limited', 'oauth_token_rejected'].includes(result.errorCode)
      ) {
        await consentPostRefused(runtime.host, prepared.consentKey)
      }
      return result
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
      const current = currentConversation(address, learned, config)
      if (!current) {
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
          ...sourceReplyFields(address, learned, config),
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
      const client = new TeamsClient(host, config, async (activity) => {
        if (
          activity.channelId !== 'msteams' ||
          activity.recipient?.id !== config.botId ||
          activity.channelData?.tenant?.id !== config.tenantId ||
          (activity.conversation?.tenantId &&
            activity.conversation.tenantId !== config.tenantId)
        ) {
          return { status: 403 }
        }
        try {
          serviceUrl(activity.serviceUrl ?? '', config)
        } catch {
          return { status: 403 }
        }
        if (
          account.allowedSenders.includes(activity.from.id) &&
          ['message', 'conversationUpdate', 'installationUpdate'].includes(
            activity.type
          )
        ) {
          await learnConversation(host, config, activity)
        }
        await receive(host, account, config, activity, client)
        return { status: 200 }
      })

      runtime = { host, account, config, client }
      await client.app()
    },
    send
  }
}
