import { apiBase } from './constants.js'
import { downloadAttachments } from './media.js'
import type { AccountConfig, ChannelHost, MediaUpload } from '@relanox/sdk'
import { MediaDownloadError } from '@relanox/channel-media'
import type { z } from 'zod'
import type { GoogleChatConfig } from './config.js'
import { ingest, secret } from './io.js'
import { serviceSchema } from './schemas.js'
import type { eventSchema } from './schemas.js'

function quoteFields(
  message: NonNullable<z.infer<typeof eventSchema>['message']>
): { quotedMessageMetadata?: { name: string; lastUpdateTime: string } } {
  const lastUpdateTime = message.lastUpdateTime ?? message.createTime
  return lastUpdateTime
    ? { quotedMessageMetadata: { name: message.name, lastUpdateTime } }
    : {}
}

export async function receive(
  host: ChannelHost,
  account: AccountConfig,
  event: z.infer<typeof eventSchema>,
  config: GoogleChatConfig
): Promise<void> {
  const { space, message } = event
  if (
    event.type !== 'MESSAGE' ||
    !space ||
    !message ||
    message.sender.type === 'BOT'
  ) {
    host.observe.log('debug', 'channel_event_ignored', {
      errorCode: 'unsupported_or_self_text'
    })
    return
  }
  if (!account.allowedSenders.includes(message.sender.name)) {
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: 'sender_not_allowed'
    })
    return
  }
  const text = message.argumentText ?? message.text ?? ''
  if (!text && !message.attachment?.length) {
    host.observe.log('debug', 'channel_event_ignored', {
      errorCode: 'unsupported_or_self_text'
    })
    return
  }
  if (
    !message.name.startsWith(`${space.name}/messages/`) ||
    (message.thread &&
      !message.thread.name.startsWith(`${space.name}/threads/`))
  ) {
    throw new Error('inconsistent_space')
  }

  let attachments: MediaUpload[]
  try {
    attachments = await downloadAttachments(message, space.name, config, host)
  } catch (error) {
    if (
      error instanceof MediaDownloadError &&
      error.code === 'media_too_large'
    ) {
      host.observe.log('info', 'channel_policy_rejection', {
        errorCode: error.code
      })
      return
    }
    throw error
  }

  const target = {
    channel: 'googlechat' as const,
    accountId: account.id,
    chatId: space.name,
    ...(message.thread ? { threadId: message.thread.name } : {}),
    replyToId: message.name,
    data: {
      space: space.name,
      ...(message.thread ? { thread: message.thread.name } : {}),
      ...quoteFields(message),
      scope: {
        clientEmail: serviceSchema.parse(
          JSON.parse(secret(config.serviceAccount)) as unknown
        ).client_email,
        apiBase: new URL(apiBase).href
      }
    }
  }

  await ingest(host, {
    source: {
      channel: 'googlechat',
      accountId: account.id,
      eventId: message.name
    },
    senderId: message.sender.name,
    text,
    attachments,
    target,
    receivedAt: Date.now(),
    context: null
  })
}
