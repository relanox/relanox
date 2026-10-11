import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AccountConfig, ChannelHost, ChannelPlugin } from '@relanox/sdk'
import { WebSocket } from 'ws'
import type { z } from 'zod'
import {
  validateConfig,
  validateTransportUrl,
  REQUEST_TIMEOUT_MS,
  RECONNECT_DELAY_MS
} from './config.js'
import type { SlackConfig } from './config.js'
import {
  socketFrameSchema,
  socketOpenResponseSchema,
  targetSchema,
  envelopeSchema,
  messageSchema
} from './schemas.js'
import { frameText, waitForStop } from './socket.js'
import { receiveMedia, sendMedia, sendOutcome } from './media.js'
import {
  bytes,
  credential,
  equal,
  fresh,
  ingest,
  jsonResponse,
  postJson
} from './transport.js'

export function createSlackChannel(
  environment: NodeJS.ProcessEnv = process.env
): ChannelPlugin<SlackConfig> {
  let host: ChannelHost
  let account: AccountConfig
  let config: SlackConfig

  const identity = (): {
    teamId: string
    appId: string
    botId: string
    apiBaseUrl: string
  } => ({
    teamId: config.teamId,
    appId: config.appId,
    botId: config.botUserId,
    apiBaseUrl: new URL(config.apiBaseUrl).toString().replace(/\/$/u, '')
  })

  let controller: AbortController | undefined
  let task: Promise<void> | undefined
  let socket: WebSocket | undefined

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
      envelope.team_id !== config.teamId ||
      envelope.api_app_id !== config.appId ||
      !envelope.event_id
    ) {
      throw new Error('event_identity_mismatch')
    }
    const event = messageSchema.parse(envelope.event)
    if (
      !['message', 'app_mention'].includes(event.type) ||
      (event.subtype && event.subtype !== 'file_share') ||
      event.bot_id ||
      event.user === config.botUserId ||
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
    await ingest(host, {
      source: {
        channel: 'slack',
        accountId: account.id,
        eventId: envelope.event_id
      },
      senderId: event.user,
      text: event.text ?? '',
      attachments: await receiveMedia(
        event.files,
        host,
        config,
        credential(config.botToken, environment)
      ),
      target: {
        channel: 'slack',
        accountId: account.id,
        chatId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        replyToId: event.ts,
        data: identity()
      },
      context: { teamId: config.teamId },
      receivedAt: Date.now()
    })
  }

  async function connect(signal: AbortSignal): Promise<void> {
    if (config.receiveMode !== 'socket') {
      return
    }

    const response = await postJson(
      `${config.apiBaseUrl.replace(/\/$/u, '')}/apps.connections.open`,
      { authorization: `Bearer ${credential(config.appToken, environment)}` },
      {},
      signal,
      REQUEST_TIMEOUT_MS
    )

    const result = socketOpenResponseSchema.parse(await jsonResponse(response))
    if (!response.ok || !result.ok || !result.url) {
      throw new Error('socket_open_failed')
    }

    const ws = new WebSocket(
      validateTransportUrl(result.url, config.allowInsecureLoopback, true),
      {
        maxPayload: 1_048_576,
        handshakeTimeout: REQUEST_TIMEOUT_MS
      }
    )

    socket = ws
    let chain = Promise.resolve()
    let pending = 0
    let failed = false
    let alive = true

    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      if (ws.readyState === WebSocket.OPEN) {
        alive = false
        ws.ping()
      }
    }, 30_000)

    const abort = (): void => {
      ws.terminate()
    }

    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    await new Promise<void>((resolve) => {
      ws.on('pong', () => {
        alive = true
      })
      ws.on('error', () => {
        host.connection('degraded', 'socket_transport_error')
        ws.terminate()
      })
      ws.on('close', () => {
        clearInterval(ping)
        signal.removeEventListener('abort', abort)
        host.connection('disconnected')
        resolve()
      })
      ws.on('message', (raw) => {
        const parsed = socketFrameSchema.safeParse(
          ((): unknown => {
            try {
              return JSON.parse(frameText(raw))
            } catch {
              return null
            }
          })()
        )

        if (!parsed.success) {
          ws.terminate()
          return
        }
        const frame = parsed.data
        if (frame.type === 'hello') {
          host.connection('connected')
          return
        }
        if (frame.type === 'disconnect') {
          ws.terminate()
          return
        }
        if (!frame.envelope_id) {
          return
        }
        if (++pending > 64) {
          ws.terminate()
          return
        }

        const consume = async (): Promise<void> => {
          if (signal.aborted || failed) {
            return
          }
          if (frame.type === 'events_api') {
            await ingestEnvelope(frame.payload)
          } else {
            host.observe.count('relanox_inbound_total', {
              channel: 'slack',
              operation: 'ingest',
              outcome: 'rejected',
              error_class: 'unsupported'
            })
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ envelope_id: frame.envelope_id }))
          }
        }

        chain = chain
          .then(consume)
          .catch(() => {
            failed = true
            host.connection('degraded', 'socket_ingest_error')
            ws.terminate()
          })
          .finally(() => {
            pending--
          })
      })
    })
    await chain
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      try {
        await connect(signal)
      } catch {
        host.connection('degraded', 'socket_connection_error')
      }
      if (signal.aborted) {
        break
      }
      await delay(
        Math.min(30_000, RECONNECT_DELAY_MS * 2 ** Math.min(failures++, 5)),
        undefined,
        { signal }
      ).catch(() => {})
    }
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
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost
      account = nextAccount
      config = nextConfig
      credential(config.botToken, environment)
      if (config.receiveMode === 'socket') {
        credential(config.appToken, environment)
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
        if (config.receiveMode !== 'http') {
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
          (envelope.team_id !== config.teamId ||
            envelope.api_app_id !== config.appId)
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
      if (task || config.receiveMode === 'http') {
        return
      }
      controller = new AbortController()
      task = run(AbortSignal.any([signal, controller.signal])).catch(() => {
        host.connection('degraded', 'socket_lifecycle_error')
      })
    },
    async stop() {
      controller?.abort()
      socket?.terminate()
      await waitForStop(task, REQUEST_TIMEOUT_MS)
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
      try {
        if (input.chunk.media) {
          return await sendMedia(
            input,
            host,
            config,
            credential(config.botToken, environment)
          )
        }

        const response = await postJson(
          `${config.apiBaseUrl.replace(/\/$/u, '')}/chat.postMessage`,
          {
            authorization: `Bearer ${credential(config.botToken, environment)}`
          },
          {
            channel: input.target.chatId,
            text: input.chunk.text
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;'),
            mrkdwn: false,
            parse: 'none',
            unfurl_links: false,
            unfurl_media: false,
            ...(input.target.threadId
              ? { thread_ts: input.target.threadId }
              : {})
          },
          input.signal,
          REQUEST_TIMEOUT_MS
        )

        return await sendOutcome(response)
      } catch {
        return { status: 'unknown', errorCode: 'slack_transport_error' }
      }
    }
  }
}
