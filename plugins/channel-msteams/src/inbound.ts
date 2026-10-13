import { acceptConsent, downloadAttachments } from './media.js'
import { MediaDownloadError } from '@relanox/channel-media'
import type { AccountConfig, ChannelHost } from '@relanox/sdk'
import type { z } from 'zod'
import type { TeamsConfig } from './config.js'
import { ingest } from './io.js'
import type { activitySchema } from './schemas.js'

export async function receive(
  host: ChannelHost,
  account: AccountConfig,
  config: TeamsConfig,
  activity: z.infer<typeof activitySchema>
): Promise<void> {
  if (!account.allowedSenders.includes(activity.from.id)) {
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: 'sender_not_allowed'
    })
    return
  }
  if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') {
    await acceptConsent(host, activity.value, {
      conversationId: activity.conversation.id,
      userId: activity.from.id,
      botId: config.botId
    })
    return
  }
  if (
    activity.type !== 'message' ||
    (!activity.text && !activity.attachments?.length) ||
    activity.from.id === config.botId
  ) {
    host.observe.log('debug', 'channel_event_ignored', {
      errorCode: 'unsupported_or_self_text'
    })
    return
  }
  if (!activity.id) {
    throw new Error('missing_activity_id')
  }
  let attachments: Awaited<ReturnType<typeof downloadAttachments>>
  try {
    attachments = await downloadAttachments(activity, host, config)
  } catch (error) {
    if (
      !(error instanceof MediaDownloadError) ||
      error.code !== 'media_too_large'
    ) {
      throw error
    }
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: error.code
    })
    return
  }
  const threadId = activity.replyToId
  await ingest(host, {
    source: {
      channel: 'msteams',
      accountId: account.id,
      eventId: `${activity.conversation.id}:${activity.id}`
    },
    senderId: activity.from.id,
    text: activity.text ?? '',
    attachments,
    receivedAt: Date.now(),
    context: { tenantId: config.tenantId },
    target: {
      channel: 'msteams',
      accountId: account.id,
      chatId: activity.conversation.id,
      ...(threadId ? { threadId } : {}),
      replyToId: activity.id,
      data: {
        appId: config.appId,
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        tenantId: config.tenantId,
        botId: config.botId,
        userId: activity.from.id,
        ...(activity.conversation.conversationType
          ? { personal: activity.conversation.conversationType === 'personal' }
          : {}),
        replyToId: threadId ?? activity.id
      }
    }
  })
}
