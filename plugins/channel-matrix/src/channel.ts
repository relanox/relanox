import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { MediaDownloadError } from '@relanox/channel-media'
import { renderHtml, splitMarkdown, textLength } from '@relanox/markdown'
import {
  ClientEvent,
  HTTPError,
  MatrixError,
  SyncState,
  THREAD_RELATION_TYPE
} from 'matrix-js-sdk'
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { matrixClient } from './client.js'
import { validateConfig, platformIdSchema, validateBaseUrl } from './config.js'
import type { MatrixConfig } from './config.js'
import { mediaCaption, messageContent, receiveMedia } from './media.js'
import { diagnose, ingest, secret, sendFailure } from './protocol.js'
import { richError } from './rich.js'
import { textSchema, targetSchema } from './schemas.js'

export function createMatrixChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ChannelPlugin<MatrixConfig> {
  let runtime:
    | {
        host: ChannelHost
        account: AccountConfig
        config: MatrixConfig
        base: string
        userId: string
        client: MatrixClient
      }
    | undefined

  let controller: AbortController | undefined
  let receiveSignal: AbortSignal | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const pending = new Set<Promise<void>>()
  let removeAbort: (() => void) | undefined

  function configured(): NonNullable<typeof runtime> {
    if (!runtime) {
      throw new Error('not_setup')
    }
    return runtime
  }

  async function receive(
    event: MatrixEvent,
    signal: AbortSignal
  ): Promise<void> {
    const { host, account, config, base, userId, client } = configured()
    const room = event.getRoomId()
    if (!room || (host.boundChatIds && !host.boundChatIds.includes(room))) {
      return
    }

    const sender = event.getSender()
    if (sender === userId) {
      return
    }
    if (event.isEncrypted()) {
      diagnose(host, 'encrypted_unsupported')
      return
    }
    if (event.getType() !== 'm.room.message') {
      return
    }
    if (!sender || !account.allowedSenders.includes(sender)) {
      diagnose(host, 'sender_not_allowed')
      return
    }
    const content = event.getContent()
    if ('file' in content) {
      diagnose(host, 'encrypted_unsupported')
      return
    }
    const relation = event.getRelation()
    if (relation && !THREAD_RELATION_TYPE.matches(relation.rel_type ?? '')) {
      diagnose(host, 'relation_unsupported')
      return
    }
    const parsed = textSchema.safeParse(content)

    const attachments = parsed.success
      ? []
      : await receiveMedia(
          content,
          host,
          config,
          client,
          {
            Authorization: `Bearer ${secret(config.accessToken, environment)}`
          },
          signal
        )

    if (!parsed.success && attachments.length === 0) {
      diagnose(host, 'nontext_unsupported')
      return
    }

    const eventId = platformIdSchema.parse(event.getId())
    const threadId = event.threadRootId
    await ingest(host, {
      source: {
        channel: 'matrix',
        accountId: account.id,
        eventId
      },
      senderId: sender,
      text: parsed.success ? parsed.data.body : mediaCaption(content),
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: event.getTs() ?? Date.now(),
      target: {
        channel: 'matrix',
        accountId: account.id,
        chatId: room,
        replyToId: eventId,
        ...(threadId ? { threadId } : {}),
        data: { homeserver: base, userId }
      },
      context: null
    })
  }

  function received(event: MatrixEvent): void {
    const signal = controller?.signal
    if (!signal || signal.aborted) {
      return
    }

    // The SDK owns sync progress; callbacks do not hold its receipt cursor.
    const task = receive(event, signal).catch((error: unknown) => {
      if (!signal.aborted) {
        diagnose(
          configured().host,
          error instanceof MediaDownloadError ? error.code : 'receive_failed'
        )
      }
    })

    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  async function checkEncryption(
    client: MatrixClient,
    room: string
  ): Promise<SendResult | null> {
    try {
      await client.getStateEvent(room, 'm.room.encryption', '')
      return { status: 'rejected', errorCode: 'encrypted_unsupported' }
    } catch (error) {
      if (
        error instanceof MatrixError &&
        error.httpStatus === 404 &&
        error.errcode === 'M_NOT_FOUND'
      ) {
        return null
      }
      if (error instanceof HTTPError && error.httpStatus === 404) {
        return { status: 'retryable', errorCode: 'encryption_check_failed' }
      }
      const failure = sendFailure(error)
      return failure.status === 'unknown'
        ? { status: 'retryable', errorCode: 'encryption_check_failed' }
        : failure
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, config, base, userId } = configured()
    const destination = targetSchema.safeParse(input.target.data)
    if (
      input.target.channel !== 'matrix' ||
      input.target.accountId !== account.id ||
      !destination.success ||
      destination.data.homeserver !== base ||
      destination.data.userId !== userId
    ) {
      return { status: 'rejected', errorCode: 'target_mismatch' }
    }
    const errorCode = richError(input)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }
    try {
      const client = matrixClient(
        base,
        secret(config.accessToken, environment),
        userId,
        input.signal
      )

      const encryptionFailure = await checkEncryption(
        client,
        input.target.chatId
      )

      if (encryptionFailure) {
        return encryptionFailure
      }
      const content = await messageContent(input, client)
      if ('status' in content) {
        return content
      }
      const replyToId = input.reply ? input.target.replyToId : undefined

      const result = await client.sendMessage(
        input.target.chatId,
        input.target.threadId ?? null,
        {
          ...content,
          ...(replyToId
            ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyToId } } }
            : {})
        },
        input.chunk.idempotencyKey
      )

      return {
        status: 'sent',
        receipt: { platformMessageId: platformIdSchema.parse(result.event_id) }
      }
    } catch (error) {
      return sendFailure(error)
    }
  }

  async function stop(): Promise<void> {
    if (stopping) {
      return stopping
    }
    removeAbort?.()
    removeAbort = undefined
    controller?.abort()

    // StartClient initializes services after awaiting /versions. Let that finish
    // Before stopClient clears clientRunning, or its late services evade cleanup.
    const task = (async (): Promise<void> => {
      try {
        await starting
      } finally {
        runtime?.client.stopClient()
        await Promise.all(pending)
        controller = undefined
        runtime?.host.connection('disconnected')
      }
    })()

    stopping = task
    try {
      await task
    } finally {
      stopping = undefined
    }
  }

  return {
    id: 'channel-matrix',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'matrix',
    splitText(markdown) {
      return splitMarkdown(markdown, {
        maxLength: 16_000,
        unit: 'utf8',
        measure: (text) =>
          textLength(text, 'utf8') + textLength(renderHtml(text), 'utf8')
      })
    },
    capabilities: {
      receive: true,
      transport: 'connection',
      maxTextLength: 16_000,
      lengthUnit: 'utf8',
      idempotentSend: false,
      get richText() {
        return {
          maxParts: 20,
          maxTextLength: 8000,
          maxImageBytes: runtime?.host.maxMediaBytes ?? 100 * 1024 * 1024
        }
      },
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      const current = configured()
      if (
        address.platform !== 'matrix' ||
        address.accountId !== current.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        (address.threadId !== undefined &&
          !platformIdSchema.safeParse(address.threadId).success)
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const prior = targetSchema.safeParse(learned?.data)

      const replyToId =
        learned?.channel === 'matrix' &&
        learned.accountId === current.account.id &&
        learned.chatId === address.chatId &&
        learned.threadId === address.threadId &&
        prior.success &&
        prior.data.homeserver === current.base &&
        prior.data.userId === current.userId
          ? learned.replyToId
          : undefined

      return {
        status: 'available',
        target: {
          channel: 'matrix',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          ...(replyToId ? { replyToId } : {}),
          data: { homeserver: current.base, userId: current.userId }
        }
      }
    },
    async setup(host, account, config) {
      if (runtime) {
        throw new Error('already_setup')
      }

      const base = validateBaseUrl(
        config.homeserver,
        config.allowInsecureLocalhost
      )

      const client = matrixClient(
        base,
        secret(config.accessToken, environment),
        undefined,
        () => receiveSignal
      )

      const userId = platformIdSchema.parse((await client.whoami()).user_id)
      client.credentials.userId = userId
      runtime = {
        host,
        account,
        config,
        base,
        userId,
        client
      }
      client.on(ClientEvent.Event, received)
      client.on(ClientEvent.Sync, (state) => {
        if (controller?.signal.aborted !== false) {
          return
        }
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          host.connection('connected')
        } else if (
          state === SyncState.Error ||
          state === SyncState.Reconnecting
        ) {
          host.connection('degraded', 'sync_failed')
        }
      })
    },
    async start(signal) {
      if (stopping) {
        await stopping
      }
      if (controller || signal.aborted) {
        return starting
      }
      const { client } = configured()
      controller = new AbortController()
      receiveSignal = controller.signal

      const abort = (): void => {
        void stop()
      }

      signal.addEventListener('abort', abort, { once: true })
      removeAbort = (): void => {
        signal.removeEventListener('abort', abort)
      }
      const task = client.startClient()
      starting = task
      try {
        await task
      } finally {
        if (starting === task) {
          starting = undefined
        }
      }
    },
    stop,
    send
  }
}
