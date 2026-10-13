import {
  requestTimeoutMs,
  reconnectDelayMs,
  syncTimeoutMs
} from './constants.js'
import { richError } from './rich.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { mediaCaption, messageContent, receiveMedia } from './media.js'
import { renderHtml, splitMarkdown, textLength } from '@relanox/markdown'
import { z } from 'zod'
import { validateConfig, platformIdSchema, validateBaseUrl } from './config.js'
import type { MatrixConfig } from './config.js'
import {
  delay,
  diagnose,
  httpFailure,
  ingest,
  readJson,
  secret,
  stopTask
} from './protocol.js'
import {
  sendResponseSchema,
  syncSchema,
  textSchema,
  targetSchema
} from './schemas.js'
import type { eventSchema } from './schemas.js'

function outboundRelation(target: SendInput['target']):
  | {
      rel_type: string
      event_id: string
      is_falling_back?: boolean
      'm.in_reply_to'?: { event_id: string }
    }
  | {
      'm.in_reply_to': { event_id: string }
      rel_type?: never
      event_id?: never
      is_falling_back?: never
    }
  | null {
  if (target.threadId) {
    if (!target.replyToId) {
      return { rel_type: 'm.thread', event_id: target.threadId }
    }
    return {
      rel_type: 'm.thread',
      event_id: target.threadId,
      is_falling_back: false,
      'm.in_reply_to': { event_id: target.replyToId ?? target.threadId }
    }
  }
  if (target.replyToId) {
    return { 'm.in_reply_to': { event_id: target.replyToId } }
  }
  return null
}

function encryptedEvent(event: z.infer<typeof eventSchema>): boolean {
  // Plaintext media events can also carry encrypted attachment descriptors.
  return (
    event.type === 'm.room.encrypted' ||
    (event.type === 'm.room.message' &&
      event.content.msgtype !== 'm.text' &&
      'file' in event.content)
  )
}

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
      }
    | undefined

  let controller: AbortController | undefined
  let task: Promise<void> | undefined

  function configured(): {
    host: ChannelHost
    account: AccountConfig
    config: MatrixConfig
    base: string
    userId: string
  } {
    if (!runtime) {
      throw new Error('not_setup')
    }
    return runtime
  }

  function headers(): { Authorization: string } {
    return {
      Authorization: `Bearer ${secret(configured().config.accessToken, environment)}`
    }
  }

  async function receive(
    room: string,
    event: z.infer<typeof eventSchema>,
    signal: AbortSignal
  ): Promise<void> {
    const { host, account, config, base, userId } = configured()
    if (event.sender === userId) {
      return
    }
    if (encryptedEvent(event)) {
      diagnose(host, 'encrypted_unsupported')
      return
    }
    if (event.type !== 'm.room.message') {
      return
    }
    if (!account.allowedSenders.includes(event.sender)) {
      diagnose(host, 'sender_not_allowed')
      return
    }
    const parsed = textSchema.safeParse(event.content)

    const attachments = parsed.success
      ? []
      : await receiveMedia(event.content, host, config, base, headers(), signal)

    if (!parsed.success && attachments.length === 0) {
      diagnose(host, 'nontext_unsupported')
      return
    }

    const relation = textSchema.shape['m.relates_to'].parse(
      event.content['m.relates_to']
    )

    if (relation?.rel_type && relation.rel_type !== 'm.thread') {
      diagnose(host, 'relation_unsupported')
      return
    }

    const threadId =
      relation?.rel_type === 'm.thread' ? relation.event_id : undefined

    if (relation?.rel_type === 'm.thread' && !threadId) {
      throw new Error('invalid_thread')
    }
    await ingest(host, {
      source: {
        channel: 'matrix',
        accountId: account.id,
        eventId: event.event_id
      },
      senderId: event.sender,
      text: parsed.success ? parsed.data.body : mediaCaption(event.content),
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: event.origin_server_ts ?? Date.now(),
      target: {
        channel: 'matrix',
        accountId: account.id,
        chatId: room,
        replyToId: event.event_id,
        ...(threadId ? { threadId } : {}),
        data: { homeserver: base, userId }
      },
      context: null
    })
  }

  async function synchronize(signal: AbortSignal): Promise<void> {
    const { host, base } = configured()
    const checkpoint = await host.state.get('sync')

    const since = checkpoint
      ? platformIdSchema.parse(checkpoint.value)
      : undefined

    const url = new URL(`${base}/_matrix/client/v3/sync`)
    url.searchParams.set('timeout', String(syncTimeoutMs))
    if (since) {
      url.searchParams.set('since', since)
    }

    const response = await fetch(url, {
      headers: headers(),
      redirect: 'error',
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(requestTimeoutMs + syncTimeoutMs)
      ])
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        response.status === 401 ? 'authentication_failed' : 'sync_failed'
      )
    }
    const data = syncSchema.parse(await readJson(response))
    for (const [room, value] of Object.entries(data.rooms?.join ?? {})) {
      if (since && value.timeline?.limited) {
        throw new Error('sync_history_gap')
      }
      for (const event of value.timeline?.events ?? []) {
        await receive(room, event, signal)
      }
    }

    const saved = await host.state.compareAndSet({
      key: 'sync',
      expectedVersion: checkpoint?.version ?? null,
      value: data.next_batch
    })

    if (saved.status !== 'updated') {
      throw new Error('sync_checkpoint_conflict')
    }
    host.connection('connected')
  }

  async function loop(signal: AbortSignal): Promise<void> {
    const { host } = configured()
    while (!signal.aborted) {
      try {
        await synchronize(signal)
      } catch (error) {
        if (!signal.aborted) {
          const code =
            error instanceof Error &&
            [
              'authentication_failed',
              'sync_history_gap',
              'sync_checkpoint_conflict'
            ].includes(error.message)
              ? error.message
              : 'sync_failed'

          host.connection('degraded', code)
          diagnose(host, code)
        }
      }
      await delay(reconnectDelayMs, signal)
    }
    host.connection('disconnected')
  }

  async function checkEncryption(
    room: string,
    signal: AbortSignal
  ): Promise<SendResult | null> {
    const { base } = configured()
    try {
      const encryption = await fetch(
        `${base}/_matrix/client/v3/rooms/${room}/state/m.room.encryption`,
        { headers: headers(), redirect: 'error', signal }
      )

      if (encryption.status === 404) {
        const missing = z
          .object({ errcode: z.literal('M_NOT_FOUND') })
          .safeParse(await readJson(encryption))

        return missing.success
          ? null
          : { status: 'retryable', errorCode: 'encryption_check_failed' }
      }
      await encryption.body?.cancel()
      if (encryption.ok) {
        return { status: 'rejected', errorCode: 'encrypted_unsupported' }
      }
      const failure = httpFailure(encryption)
      return failure.status === 'unknown'
        ? { status: 'retryable', errorCode: 'encryption_check_failed' }
        : failure
    } catch {
      // This read cannot send a message, so its transport failures are safe to retry.
      return { status: 'retryable', errorCode: 'encryption_check_failed' }
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, base, userId, host } = configured()
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
    const errorCode = richError(input, host)
    if (errorCode) {
      return { status: 'rejected', errorCode }
    }
    const room = encodeURIComponent(input.target.chatId)

    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(requestTimeoutMs)
    ])

    const encryptionFailure = await checkEncryption(room, signal)
    if (encryptionFailure) {
      return encryptionFailure
    }
    try {
      const relation = outboundRelation(input.target)
      const content = await messageContent(input, base, headers(), signal)
      if ('status' in content) {
        return content
      }

      const response = await fetch(
        `${base}/_matrix/client/v3/rooms/${room}/send/m.room.message/${encodeURIComponent(input.chunk.idempotencyKey)}`,
        {
          method: 'PUT',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          redirect: 'error',
          signal,
          body: JSON.stringify({
            ...content,
            ...(relation ? { 'm.relates_to': relation } : {})
          })
        }
      )

      if (!response.ok) {
        await response.body?.cancel()
        return httpFailure(response)
      }
      const result = sendResponseSchema.parse(await readJson(response))
      return { status: 'sent', receipt: { platformMessageId: result.event_id } }
    } catch {
      return { status: 'unknown', errorCode: 'send_outcome_unknown' }
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
          maxImageBytes: runtime?.host.maxMediaBytes ?? 16_777_216
        }
      },
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async resolveChannel(address) {
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
      return {
        status: 'available',
        target: {
          channel: 'matrix',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
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

      const response = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
        headers: {
          Authorization: `Bearer ${secret(config.accessToken, environment)}`
        },
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMs)
      })

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('identity_discovery_failed')
      }

      const identity = z
        .object({ user_id: platformIdSchema })
        .parse(await readJson(response))

      runtime = {
        host,
        account,
        config,
        base,
        userId: identity.user_id
      }
    },
    async start(signal) {
      if (task) {
        return
      }
      configured()
      controller = new AbortController()
      task = loop(AbortSignal.any([signal, controller.signal])).finally(() => {
        task = undefined
      })
    },
    async stop() {
      controller?.abort()
      runtime?.host.connection('disconnected')
      await stopTask(task)
    },
    send
  }
}
