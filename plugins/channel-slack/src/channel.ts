import { API_BASE_URL, validateConfig } from './config.js'
import { createHmac } from 'node:crypto'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  ChannelAddress,
  ReplyTarget,
  IngestInput
} from '@relanox/sdk'
import { SocketModeClient } from '@slack/socket-mode'
import {
  createClient,
  discoverIdentity,
  sendOutcome,
  sdkFailure,
  sdkOptions
} from './client.js'
import type { z } from 'zod'
import type { SlackConfig } from './config.js'
import { targetSchema, envelopeSchema, messageSchema } from './schemas.js'
import {
  receiveMedia,
  MediaDownloadError,
  sendMedia,
  richBlocks,
  richError,
  richCapabilities,
  slackMarkdown,
  splitSlackMarkdown
} from './media.js'
import { bytes, credential, equal, fresh, ingest } from './transport.js'

function messageThreadId(
  event: z.infer<typeof messageSchema>
): string | undefined {
  return (
    event.thread_ts ??
    (event.subtype === 'thread_broadcast' ? event.root?.thread_ts : undefined)
  )
}

function inboundMessageId(
  event: z.infer<typeof messageSchema>,
  teamId: string,
  envelopeEventId: string
): string {
  if (event.subtype !== undefined || event.files.length > 0) {
    return envelopeEventId
  }
  // Slack can dispatch one post through both message.* and app_mention.
  // The envelope IDs identify different events; these fields identify the post.
  return `slack-message:${JSON.stringify([teamId, event.channel, event.ts])}`
}

function sourceReplyId(
  address: ChannelAddress,
  learned: ReplyTarget | undefined,
  current: z.infer<typeof targetSchema>
): string | undefined {
  const source = targetSchema.safeParse(learned?.data)
  return learned?.channel === 'slack' &&
    learned.accountId === address.accountId &&
    learned.chatId === address.chatId &&
    learned.threadId === address.threadId &&
    source.success &&
    source.data.teamId === current.teamId &&
    source.data.appId === current.appId &&
    source.data.botId === current.botId &&
    source.data.apiBaseUrl === current.apiBaseUrl &&
    learned.replyToId !== undefined &&
    /^\d+\.\d+$/u.test(learned.replyToId)
    ? learned.replyToId
    : undefined
}

export function createSlackChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<SlackConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: SlackConfig
  let botUserId: string
  let teamId: string

  const identity = (): {
    teamId: string
    appId: string
    botId: string
    apiBaseUrl: string
  } => ({
    teamId,
    appId: config.appId,
    botId: botUserId,
    apiBaseUrl: new URL(API_BASE_URL).toString().replace(/\/$/u, '')
  })

  let socket: SocketModeClient | undefined
  let receiveSignal: AbortSignal | undefined
  let task: Promise<unknown> | undefined
  const inbound = new Set<Promise<void>>()

  function abortSocket(): void {
    void socket?.disconnect().catch(() => {
      host.connection('degraded', 'socket_stop_error')
    })
  }

  async function ingestWithMedia(
    input: Omit<IngestInput, 'attachments'>,
    files: z.infer<typeof messageSchema>['files']
  ): Promise<void> {
    try {
      const attachments = await receiveMedia(
        files,
        host,
        credential(config.botToken, environment),
        createClient(credential(config.botToken, environment), receiveSignal)
      )

      await ingest(host, { ...input, attachments })
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
    }
  }

  async function ingestEnvelope(value: unknown): Promise<void> {
    const envelope = envelopeSchema.parse(value)
    if (envelope.type !== 'event_callback') {
      host.observe.count('relanox_inbound_total', {
        channel: 'slack',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'unsupported'
      })
      return
    }
    if (
      envelope.team_id !== teamId ||
      envelope.api_app_id !== config.appId ||
      !envelope.event_id
    ) {
      throw new Error('event_identity_mismatch')
    }
    const event = messageSchema.parse(envelope.event)

    const threadId = messageThreadId(event)

    if (
      !['message', 'app_mention'].includes(event.type) ||
      (event.subtype &&
        !['file_share', 'me_message', 'thread_broadcast'].includes(
          event.subtype
        )) ||
      (event.subtype === 'thread_broadcast' && !threadId) ||
      event.bot_id ||
      event.user === botUserId ||
      (!event.text && event.files.length === 0) ||
      !event.user ||
      !event.channel ||
      !event.ts
    ) {
      host.observe.count('relanox_inbound_total', {
        channel: 'slack',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'unsupported'
      })
      return
    }
    // Check the canonical native sender before any credentialed file requests.
    // Core ingest remains authoritative for bindings and their narrower policy.
    if (!account.allowedSenders.includes(event.user)) {
      host.observe.count('relanox_inbound_total', {
        channel: 'slack',
        operation: 'ingest',
        outcome: 'rejected',
        error_class: 'sender_not_allowed'
      })
      return
    }
    await ingestWithMedia(
      {
        source: {
          channel: 'slack',
          accountId: account.id,
          eventId: inboundMessageId(event, teamId, envelope.event_id)
        },
        senderId: event.user,
        text: event.text ?? '',
        target: {
          channel: 'slack',
          accountId: account.id,
          chatId: event.channel,
          ...(threadId ? { threadId } : {}),
          replyToId: event.ts,
          data: identity()
        },
        context: { teamId },
        receivedAt: Date.now()
      },
      event.files
    )
  }

  return {
    id: 'channel-slack',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'slack',
    capabilities: {
      receive: true,
      transport: 'both',
      maxTextLength: 4000,
      richText: richCapabilities,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async resolveChannel(address, learned) {
      if (
        address.platform !== 'slack' ||
        address.accountId !== account.id ||
        !/^[A-Z0-9]+$/u.test(address.chatId) ||
        (address.threadId !== undefined &&
          !/^\d+\.\d+$/u.test(address.threadId))
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const replyToId = sourceReplyId(address, learned, identity())

      return {
        status: 'available',
        target: {
          channel: 'slack',
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId !== undefined
            ? { threadId: address.threadId }
            : {}),
          ...(replyToId ? { replyToId } : {}),
          data: identity()
        }
      }
    },

    splitText: splitSlackMarkdown,
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = nextConfig

      const discovered = await discoverIdentity(
        createClient(credential(config.botToken, environment))
      )

      botUserId = discovered.botUserId
      teamId = discovered.teamId
      if ('appToken' in config) {
        const options = sdkOptions()
        socket = new SocketModeClient({
          appToken: credential(config.appToken, environment),
          clientOptions: options,
          ...(options.logger ? { logger: options.logger } : {})
        })
        socket.on('connected', () => {
          host.connection('connected')
        })
        socket.on('disconnected', () => {
          host.connection('disconnected')
        })
        socket.on('reconnecting', () => {
          host.connection('disconnected')
        })
        socket.on('error', () => {
          host.connection('degraded', 'socket_transport_error')
        })
        socket.on(
          'slack_event',
          ({
            body,
            ack
          }: {
            body: unknown
            ack(this: void): Promise<void>
          }) => {
            const work = (async (): Promise<void> => {
              await ingestEnvelope(body)
              if (!receiveSignal?.aborted) {
                await ack()
              }
            })()
              .catch(() => {
                host.connection('degraded', 'socket_ingest_error')
              })
              .finally(() => inbound.delete(work))

            inbound.add(work)
          }
        )
        return
      }
      credential(config.signingSecret, environment)
      host.mountHttp('/events', async (request) => {
        if (request.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const timestamp = request.headers.get('x-slack-request-timestamp')
        if (!fresh(timestamp)) {
          return new Response(null, { status: 401 })
        }
        let body: Buffer
        try {
          body = await bytes(request)
        } catch {
          return new Response(null, { status: 413 })
        }
        if (!('signingSecret' in config)) {
          return new Response(null, { status: 404 })
        }

        const digest = createHmac(
          'sha256',
          credential(config.signingSecret, environment)
        )
          .update(`v0:${timestamp}:`)
          .update(body)
          .digest('hex')

        if (
          !equal(request.headers.get('x-slack-signature') ?? '', `v0=${digest}`)
        ) {
          return new Response(null, { status: 401 })
        }
        let envelope: z.infer<typeof envelopeSchema>
        try {
          envelope = envelopeSchema.parse(JSON.parse(body.toString('utf8')))
        } catch {
          return new Response(null, { status: 400 })
        }
        if (envelope.type === 'url_verification' && envelope.challenge) {
          return Response.json({ challenge: envelope.challenge })
        }
        if (
          envelope.type === 'event_callback' &&
          (envelope.team_id !== teamId || envelope.api_app_id !== config.appId)
        ) {
          return new Response(null, { status: 401 })
        }
        try {
          await ingestEnvelope(envelope)
          return new Response(null, { status: 204 })
        } catch {
          return new Response(null, { status: 503 })
        }
      })
    },
    async start(signal) {
      if (!socket || task) {
        return
      }
      receiveSignal = signal
      signal.throwIfAborted()
      signal.addEventListener('abort', abortSocket, { once: true })
      task = socket.start().catch(() => {
        host.connection('degraded', 'socket_lifecycle_error')
      })
    },
    async stop() {
      receiveSignal?.removeEventListener('abort', abortSocket)
      await socket?.disconnect()
      await task
      await Promise.all(inbound)
      task = undefined
    },
    async send(input) {
      const data = targetSchema.safeParse(input.target.data)
      const current = identity()
      if (
        input.target.channel !== 'slack' ||
        input.target.accountId !== account.id ||
        !/^[A-Z0-9]+$/u.test(input.target.chatId) ||
        !data.success ||
        data.data.teamId !== current.teamId ||
        data.data.appId !== current.appId ||
        data.data.botId !== current.botId ||
        data.data.apiBaseUrl !== current.apiBaseUrl ||
        (input.target.threadId && !/^\d+\.\d+$/u.test(input.target.threadId))
      ) {
        return { status: 'rejected', errorCode: 'invalid_target' }
      }
      const errorCode = richError(input)
      if (errorCode) {
        return { status: 'rejected', errorCode }
      }
      try {
        input.signal.throwIfAborted()

        const client = createClient(
          credential(config.botToken, environment),
          input.signal
        )

        const threadId =
          input.target.threadId ??
          (input.reply ? input.target.replyToId : undefined)

        if (input.chunk.media) {
          return await sendMedia(input, client)
        }

        const formatted = input.chunk.richText
          ? await richBlocks(input, client)
          : slackMarkdown(input.chunk.text)

        if ('status' in formatted) {
          return formatted
        }

        const { postMessage: postSlackMessage } = client.chat

        const response = await postSlackMessage({
          channel: input.target.chatId,
          ...formatted,
          mrkdwn: false,
          parse: 'none',
          unfurl_links: false,
          unfurl_media: false,
          ...(threadId ? { thread_ts: threadId } : {})
        })

        return sendOutcome(response)
      } catch (error) {
        return sdkFailure(error)
      }
    }
  }
}
