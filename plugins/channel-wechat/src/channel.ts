import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { MediaDownloadError } from '@relanox/channel-media'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  Json,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { validateConfig } from './config.js'
import type { WechatConfig } from './config.js'
import { WechatClient, contextSchema, updatesSchema } from './protocol.js'
import { ApiError } from './errors.js'
import type { WechatMessage } from './protocol.js'
import { receiveMedia, uploadMedia } from './media.js'

export function createWechatChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ChannelPlugin<WechatConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: WechatConfig
  let client: WechatClient
  let controller: AbortController | undefined
  let task: Promise<void> | undefined

  function identity(): { botId: string; apiBaseUrl: string } {
    return { botId: config.botId, apiBaseUrl: new URL(config.apiBaseUrl).href }
  }

  function key(name: string): string {
    return `${encodeURIComponent(config.botId)}:${encodeURIComponent(new URL(config.apiBaseUrl).href)}:${name}`
  }

  async function save(name: string, value: Json): Promise<void> {
    const stateKey = key(name)
    const previous = await host.state.get(stateKey)

    const result = await host.state.compareAndSet({
      key: stateKey,
      expectedVersion: previous?.version ?? null,
      value
    })

    if (result.status !== 'updated') {
      throw new Error('wechat_state_conflict')
    }
  }

  async function accept(
    message: WechatMessage,
    signal: AbortSignal
  ): Promise<void> {
    const sender = message.from_user_id
    if (
      !sender ||
      message.message_type !== 1 ||
      message.message_state === 1 ||
      message.group_id
    ) {
      return
    }
    if (message.to_user_id && message.to_user_id !== config.botId) {
      return
    }
    host.discoverConversation?.({ chatId: sender, senderId: sender })
    if (!account.allowedSenders.includes(sender)) {
      return
    }
    const id = message.message_id ?? message.client_id
    if (id === undefined) {
      throw new Error('wechat_missing_message_id')
    }
    const contextToken = message.context_token
    if (!contextToken) {
      return
    }
    const data = { ...identity(), contextToken }

    const text = message.item_list
      .map((item) =>
        item.type === 1
          ? (item.text_item?.text ?? '')
          : (item.voice_item?.text ?? '')
      )
      .filter(Boolean)
      .join('\n')

    const attachments = await receiveMedia(
      client,
      message.item_list,
      host.maxMediaBytes ?? 20 * 1024 * 1024,
      signal
    )

    if (!text && attachments.length === 0) {
      return
    }
    // Core acceptance owns deduplication. Never advance the cursor before every
    // Accepted event and its reply context are durable; replay after a crash is safe.
    await host.ingest({
      source: { channel: 'wechat', accountId: account.id, eventId: String(id) },
      senderId: sender,
      text,
      attachments,
      target: {
        channel: 'wechat',
        accountId: account.id,
        chatId: sender,
        replyToId: String(id),
        data
      },
      receivedAt: message.create_time_ms ?? Date.now(),
      context: null
    })
    await save(`context:${sender}`, data)
  }

  async function poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let retryMs = 1000
      try {
        const prior = await host.state.get(key('cursor'))
        const cursor = typeof prior?.value === 'string' ? prior.value : ''

        const result = updatesSchema.parse(
          await client.post(
            'getupdates',
            { get_updates_buf: cursor },
            signal,
            45_000
          )
        )

        host.connection('connected')
        for (const message of result.msgs) {
          await receive(message, signal)
        }
        if (result.get_updates_buf) {
          await save('cursor', result.get_updates_buf)
        }
        continue
      } catch (error) {
        if (signal.aborted) {
          return
        }
        const expired = error instanceof ApiError && error.code === -14
        host.connection(
          'degraded',
          expired ? 'wechat_session_expired' : 'wechat_poll_failed'
        )
        if (expired) {
          retryMs = 3_600_000
        }
      }
      await delay(retryMs, undefined, { signal }).catch(() => {})
    }
  }

  async function receive(
    message: WechatMessage,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await accept(message, signal)
    } catch (error) {
      const policy = z.object({ code: z.string() }).safeParse(error)
      if (
        policy.success &&
        [
          'sender_not_allowed',
          'unbound_conversation',
          'media_total_too_large'
        ].includes(policy.data.code)
      ) {
        return
      }
      if (
        error instanceof MediaDownloadError &&
        error.code === 'media_too_large'
      ) {
        return
      }
      throw error
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const data = contextSchema.safeParse(input.target.data)
    const current = identity()
    if (
      input.target.channel !== 'wechat' ||
      input.target.accountId !== account.id ||
      input.target.threadId ||
      !data.success ||
      data.data.botId !== current.botId ||
      data.data.apiBaseUrl !== current.apiBaseUrl
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    let item: Json = { type: 1, text_item: { text: input.chunk.text } }
    // Uploads are preparatory; retrying them cannot duplicate a chat message.
    try {
      if (input.chunk.media) {
        if (!input.media) {
          return { status: 'rejected', errorCode: 'missing_media' }
        }
        item = await uploadMedia(
          client,
          input.media,
          input.target.chatId,
          input.signal
        )
      }
    } catch {
      return { status: 'retryable', errorCode: 'wechat_upload_failed' }
    }
    try {
      await client.post(
        'sendmessage',
        {
          msg: {
            from_user_id: '',
            to_user_id: input.target.chatId,
            client_id: input.chunk.idempotencyKey,
            message_type: 2,
            message_state: 2,
            context_token: data.data.contextToken,
            item_list: [item]
          }
        },
        input.signal
      )
      return {
        status: 'sent',
        receipt: { data: { clientId: input.chunk.idempotencyKey } }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.httpStatus === 429) {
          return { status: 'retryable', errorCode: 'wechat_rate_limited' }
        }
        if (error.httpStatus === undefined || error.httpStatus < 500) {
          return {
            status: 'rejected',
            errorCode:
              error.code === -14
                ? 'wechat_session_expired'
                : 'wechat_send_rejected'
          }
        }
      }
      return { status: 'unknown', errorCode: 'wechat_send_unknown' }
    }
  }

  return {
    id: 'channel-wechat',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'wechat',
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 4000,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'video', 'file']
      }
    },
    validateConfig,
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = nextConfig
      client = new WechatClient(config, environment)
      if (!environment[config.botToken.env]) {
        throw new Error('missing_bot_token')
      }
    },
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'wechat' ||
        address.accountId !== account.id ||
        address.threadId
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const saved = await host.state.get(key(`context:${address.chatId}`))

      const prior =
        learned?.channel === 'wechat' &&
        learned.accountId === account.id &&
        learned.chatId === address.chatId &&
        !learned.threadId
          ? learned.data
          : undefined

      const data = contextSchema.safeParse(saved?.value ?? prior)
      const current = identity()
      if (
        !data.success ||
        data.data.botId !== current.botId ||
        data.data.apiBaseUrl !== current.apiBaseUrl
      ) {
        return { status: 'unavailable', reason: 'missing_context' }
      }
      return {
        status: 'available',
        target: {
          channel: 'wechat',
          accountId: account.id,
          chatId: address.chatId,
          data: data.data
        }
      }
    },
    async start(signal) {
      if (task) {
        throw new Error('wechat_already_started')
      }
      controller = new AbortController()
      task = poll(AbortSignal.any([signal, controller.signal]))
    },
    async stop() {
      controller?.abort()
      await task
      task = undefined
      host.connection('disconnected')
    },
    send
  }
}
