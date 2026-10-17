import { API_BASE, UPLOAD_BASE, configSchema } from './config.js'
import { receiveContent, mediaMessage, uploadFailure } from './media.js'
import { richCapabilities, richError } from './rich.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import type { z } from 'zod'
import type { DWClientDownStream } from 'dingtalk-stream'
import { DingTalkApi } from './native.js'
import { DingTalkStream } from './stream.js'
import type { DingTalkConfig } from './config.js'
import { messageSchema, targetSchema } from './schemas.js'
import type { scopeSchema } from './schemas.js'
import { ingestText, sendFailure } from './transport.js'

function hasMedia(input: SendInput): boolean {
  return input.chunk.media !== undefined || input.chunk.richText !== undefined
}

function matchesScope(
  scope: z.infer<typeof scopeSchema>,
  config: DingTalkConfig,
  media = false
): boolean {
  return (
    scope.clientId === config.clientId &&
    scope.robotCode === config.robotCode &&
    scope.apiBase === new URL(API_BASE).href &&
    (!media || scope.uploadBase === new URL(UPLOAD_BASE).href)
  )
}

function configuredType(
  types: DingTalkConfig['recipientTypes'],
  chatId: string
): 'single' | 'group' | undefined {
  return types && Object.hasOwn(types, chatId) ? types[chatId] : undefined
}

export function createDingTalkChannel(): ChannelPlugin<DingTalkConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: DingTalkConfig
  let connection: DingTalkStream
  let api: DingTalkApi
  let signal = AbortSignal.abort()

  async function receive(frame: DWClientDownStream): Promise<void> {
    const ack = (): void => {
      connection.socketCallBackResponse(frame.headers.messageId, null)
    }

    const message = messageSchema.parse(JSON.parse(frame.data))
    if (
      message.robotCode !== config.robotCode ||
      message.senderId === message.chatbotUserId ||
      (message.conversationType === '2' && message.isInAtList !== true)
    ) {
      ack()
      return
    }
    if (!account.allowedSenders.includes(message.senderId)) {
      host.observe.log('info', 'channel_input_discarded', {
        errorCode: 'sender_not_allowed'
      })
      ack()
      return
    }
    if (
      !['text', 'picture', 'audio', 'video', 'file', 'richText'].includes(
        message.msgtype
      ) ||
      (message.msgtype !== 'text' && !message.content)
    ) {
      host.observe.log('info', 'channel_unsupported_input', {
        errorCode: 'unsupported_message_type'
      })
      ack()
      return
    }
    const group = message.conversationType === '2'
    const chatId = group ? message.conversationId : message.senderStaffId
    if (!chatId) {
      ack()
      host.observe.log('warn', 'channel_unsupported_sender', {
        errorCode: 'missing_staff_id'
      })
      return
    }

    const content = await receiveContent(message, host, api, signal)
    if (!content) {
      ack()
      return
    }
    const { text, attachments } = content

    const scope = {
      clientId: config.clientId,
      robotCode: config.robotCode,
      apiBase: new URL(API_BASE).href,
      uploadBase: new URL(UPLOAD_BASE).href
    }

    await ingestText(host, {
      source: {
        channel: 'dingtalk',
        accountId: account.id,
        eventId: message.msgId
      },
      senderId: message.senderId,
      text,
      attachments,
      target: {
        channel: 'dingtalk',
        accountId: account.id,
        chatId,
        replyToId: message.msgId,
        data: group
          ? { type: 'group', openConversationId: message.conversationId, scope }
          : { type: 'single', staffId: chatId, scope }
      },
      receivedAt: Date.now(),
      context: null
    })
    ack()
  }

  return {
    id: 'channel-dingtalk',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'dingtalk',
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 4000,
      richText: richCapabilities,
      lengthUnit: 'utf8',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig: (value) => configSchema.parse(value),
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'dingtalk' ||
        address.accountId !== account.id ||
        !address.chatId ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const prior = targetSchema.safeParse(learned?.data)

      const known =
        learned?.channel === 'dingtalk' &&
        learned.accountId === account.id &&
        learned.chatId === address.chatId &&
        learned.threadId === undefined &&
        prior.success &&
        matchesScope(prior.data.scope, config) &&
        address.chatId ===
          (prior.data.type === 'group'
            ? prior.data.openConversationId
            : prior.data.staffId)
          ? prior.data.type
          : undefined

      const type =
        configuredType(config.recipientTypes, address.chatId) ?? known

      if (!type) {
        return { status: 'unavailable', reason: 'address_unresolved' }
      }

      const scope = {
        clientId: config.clientId,
        robotCode: config.robotCode,
        apiBase: new URL(API_BASE).href,
        uploadBase: new URL(UPLOAD_BASE).href
      }

      return {
        status: 'available',
        target: {
          channel: 'dingtalk',
          accountId: account.id,
          chatId: address.chatId,
          data:
            type === 'group'
              ? { type, openConversationId: address.chatId, scope }
              : { type, staffId: address.chatId, scope }
        }
      }
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = configSchema.parse(nextConfig)
      api = new DingTalkApi(config)
      connection = new DingTalkStream(config, host, async (frame) => {
        try {
          await receive(frame)
        } catch {
          // No ACK: let Stream redeliver after transient download/storage failure.
          host.observe.log('warn', 'channel_input_failed', {
            errorCode: 'ingest_failed'
          })
        }
      })
    },
    async start(nextSignal) {
      nextSignal.throwIfAborted()
      signal = nextSignal
      nextSignal.addEventListener(
        'abort',
        () => {
          connection.disconnect()
        },
        { once: true }
      )
      await connection.connect()
      host.connection(connection.connected ? 'connected' : 'degraded')
    },
    async stop() {
      connection.disconnect()
      host.connection('disconnected')
    },
    async send(input: SendInput): Promise<SendResult> {
      const target = targetSchema.safeParse(input.target.data)
      if (
        input.target.channel !== 'dingtalk' ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      const data = target.data
      if (!matchesScope(data.scope, config, hasMedia(input))) {
        return { status: 'rejected', errorCode: 'target_identity_changed' }
      }
      if (
        input.target.chatId !==
        (data.type === 'group' ? data.openConversationId : data.staffId)
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      const invalid = richError(input)
      if (invalid) {
        return { status: 'rejected', errorCode: invalid }
      }
      let credential: string
      try {
        credential = await api.token(input.signal)
      } catch (error) {
        const failure = sendFailure(error)
        if (failure.status !== 'unknown') {
          return failure
        }
        return { status: 'retryable', errorCode: 'token_unavailable' }
      }
      let transmitting = false
      try {
        const payload = await mediaMessage(input, credential)
        transmitting = true

        const body = await api.send(data, payload, credential, input.signal)

        if (body.invalidStaffIdList?.length) {
          return { status: 'rejected', errorCode: 'invalid_staff_id' }
        }
        if (body.flowControlledStaffIdList?.length) {
          return {
            status: 'retryable',
            errorCode: 'staff_rate_limited',
            retryAfterMs: 1000
          }
        }
        if (!body.processQueryKey) {
          return { status: 'unknown', errorCode: 'missing_message_receipt' }
        }
        return {
          status: 'sent',
          receipt: { data: { processQueryKey: body.processQueryKey } }
        }
      } catch (error) {
        return transmitting ? sendFailure(error) : uploadFailure(error)
      }
    }
  }
}
