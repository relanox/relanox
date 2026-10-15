import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  ChannelAddress,
  ReplyTarget,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { receiveFiles, uploadFile } from './media.js'
import { richError, richMarkdown } from './rich.js'
import { MattermostClient, mattermostWebSocket } from './client.js'
import type { WebSocketEvents, WebSocketMessage } from '@mattermost/client'
import { validateConfig, validateBaseUrl, platformIdSchema } from './config.js'
import type { MattermostConfig } from './config.js'
import { diagnose, sendFailure, ingest, secret } from './protocol.js'
import { postSchema, targetSchema } from './schemas.js'

function sourceReplyId(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  base: string,
  botUserId: string
): string | undefined {
  const source = targetSchema.safeParse(learned?.data)
  return learned?.channel === 'mattermost' &&
    learned.accountId === address.accountId &&
    learned.chatId === address.chatId &&
    learned.threadId === address.threadId &&
    source.success &&
    source.data.serverUrl === base &&
    source.data.botUserId === botUserId &&
    platformIdSchema.safeParse(learned.replyToId).success
    ? learned.replyToId
    : undefined
}

export function createMattermostChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ChannelPlugin<MattermostConfig> {
  let runtime:
    | {
        host: ChannelHost
        account: AccountConfig
        config: MattermostConfig
        base: string
        botUserId: string
      }
    | undefined

  let controller: AbortController | undefined
  let socket: ReturnType<typeof mattermostWebSocket> | undefined
  const pending = new Set<Promise<void>>()
  let removeAbort: (() => void) | undefined

  function configured(): {
    host: ChannelHost
    account: AccountConfig
    config: MattermostConfig
    base: string
    botUserId: string
  } {
    if (!runtime) {
      throw new Error('not_setup')
    }
    return runtime
  }

  async function receive(
    frame: WebSocketMessage,
    signal: AbortSignal
  ): Promise<void> {
    const { host, account, config, base, botUserId } = configured()
    // SDK event constants are declaration-only const enums under verbatim modules.
    if (frame.event !== ('posted' as WebSocketEvents.Posted)) {
      return
    }
    const post = postSchema.parse(JSON.parse(frame.data.post) as unknown)
    if (post.user_id === botUserId) {
      return
    }
    if (!account.allowedSenders.includes(post.user_id)) {
      diagnose(host, 'sender_not_allowed')
      return
    }
    if (
      (post.type !== '' && post.type !== 'me') ||
      (!post.message && post.file_ids.length === 0)
    ) {
      diagnose(host, 'nontext_unsupported')
      return
    }

    const attachments = await receiveFiles(
      post,
      host,
      config,
      new MattermostClient(base, secret(config.token, environment), signal),
      signal
    )

    if (!attachments) {
      return
    }

    await ingest(host, {
      source: {
        channel: 'mattermost',
        accountId: account.id,
        eventId: post.id
      },
      senderId: post.user_id,
      text: post.message,
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: post.create_at,
      target: {
        channel: 'mattermost',
        accountId: account.id,
        chatId: post.channel_id,
        ...(post.root_id ? { threadId: post.root_id } : {}),
        replyToId: post.id,
        data: { serverUrl: base, botUserId }
      },
      context: null
    })
  }

  function received(frame: WebSocketMessage, signal: AbortSignal): void {
    if (signal.aborted) {
      return
    }

    // The SDK's in-memory receipt cursor is independent of asynchronous ingestion.
    const task = receive(frame, signal).catch(() => {
      if (!signal.aborted) {
        diagnose(configured().host, 'receive_failed')
      }
    })

    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  async function stop(): Promise<void> {
    removeAbort?.()
    removeAbort = undefined
    controller?.abort()
    controller = undefined
    socket?.close()
    socket = undefined
    await Promise.all(pending)
    runtime?.host.connection('disconnected')
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, config, base, botUserId, host } = configured()
    const destination = targetSchema.safeParse(input.target.data)
    if (
      input.target.channel !== 'mattermost' ||
      input.target.accountId !== account.id ||
      !destination.success ||
      destination.data.serverUrl !== base ||
      destination.data.botUserId !== botUserId
    ) {
      return { status: 'rejected', errorCode: 'target_mismatch' }
    }
    const errorCode = richError(input, host)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }

    const message = input.chunk.richText
      ? await richMarkdown(input, host).catch(() => ({
          status: 'retryable' as const,
          errorCode: 'media_publication_failed'
        }))
      : input.chunk.text

    if (typeof message !== 'string') {
      return message
    }
    try {
      const client = new MattermostClient(
        base,
        secret(config.token, environment),
        input.signal
      )

      const upload = input.media ? await uploadFile(input, client) : undefined
      if (upload && !('fileId' in upload)) {
        return upload
      }

      const rootId =
        input.target.threadId ??
        (input.reply ? input.target.replyToId : undefined)

      const result = await client.createPost({
        channel_id: input.target.chatId,
        message,
        ...(upload && 'fileId' in upload ? { file_ids: [upload.fileId] } : {}),
        ...(rootId ? { root_id: rootId } : {})
      })

      return {
        status: 'sent',
        receipt: { platformMessageId: platformIdSchema.parse(result.id) }
      }
    } catch (error) {
      return sendFailure(error)
    }
  }

  return {
    id: 'channel-mattermost',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'mattermost',
    get capabilities(): ChannelPlugin<MattermostConfig>['capabilities'] {
      return {
        receive: true,
        transport: 'connection',
        maxTextLength: 16_000,
        lengthUnit: 'codepoint',
        idempotentSend: false,
        ...(runtime?.host.publicUrl && runtime.host.media
          ? {
              richText: {
                maxParts: 20,
                maxTextLength: 8000,
                maxImageBytes: runtime.host.maxMediaBytes ?? 100 * 1024 * 1024
              }
            }
          : {}),
        media: {
          receive: ['image', 'audio', 'video', 'file'],
          send: ['image', 'audio', 'video', 'file']
        }
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      const current = configured()
      if (
        address.platform !== 'mattermost' ||
        address.accountId !== current.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        (address.threadId !== undefined &&
          !platformIdSchema.safeParse(address.threadId).success)
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }

      const replyToId = sourceReplyId(
        address,
        learned,
        current.base,
        current.botUserId
      )

      return {
        status: 'available',
        target: {
          channel: 'mattermost',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          ...(replyToId ? { replyToId } : {}),
          data: { serverUrl: current.base, botUserId: current.botUserId }
        }
      }
    },

    async setup(host, account, config) {
      if (runtime) {
        throw new Error('already_setup')
      }

      const base = validateBaseUrl(
        config.serverUrl,
        config.allowInsecureLocalhost
      )

      const client = new MattermostClient(
        base,
        secret(config.token, environment)
      )

      const botUserId = platformIdSchema.parse((await client.getMe()).id)

      runtime = {
        host,
        account,
        config,
        base,
        botUserId
      }
    },
    async start(signal) {
      if (controller || signal.aborted) {
        return
      }
      const { host, config, base } = configured()
      const active = new AbortController()
      controller = active
      const connection = mattermostWebSocket()
      socket = connection
      const current = connection.client
      current.addMessageListener((frame): void => {
        received(frame, active.signal)
      })

      const connected = (): void => {
        if (!active.signal.aborted) {
          host.connection('connected')
        }
      }

      const degraded = (): void => {
        if (!active.signal.aborted) {
          host.connection('degraded', 'connection_failed')
        }
      }

      current.addFirstConnectListener(connected)
      current.addReconnectListener(connected)
      current.addErrorListener(degraded)
      current.addCloseListener(degraded)
      current.addMissedMessageListener((): void => {
        if (!active.signal.aborted) {
          diagnose(host, 'history_gap')
        }
      })

      const abort = (): void => {
        void stop()
      }

      signal.addEventListener('abort', abort, { once: true })
      removeAbort = (): void => {
        signal.removeEventListener('abort', abort)
      }
      const url = new URL(`${base}/api/v4/websocket`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      current.initialize(url.href, secret(config.token, environment))
    },
    stop,
    send
  }
}
