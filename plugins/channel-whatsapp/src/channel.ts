import { whatsAppMarkdown, splitWhatsAppMarkdown } from './markdown.js'
import {
  API_VERSION,
  API_BASE,
  validateConfig,
  validateEndpointUrl,
  platformIdSchema
} from './config.js'
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult
} from '@relanox/sdk'
import { receiveMedia, uploadMedia } from './media.js'
import { z } from 'zod'
import type { WhatsAppConfig } from './config.js'
import {
  failure,
  ingest,
  parseBody,
  rawBody,
  request,
  secret,
  signed,
  unavailable
} from './io.js'
import { webhookSchema, targetSchema, responseSchema } from './schemas.js'
import type { messageSchema } from './schemas.js'

function windowKey(config: WhatsAppConfig, customer: string): string {
  return `window:${JSON.stringify([API_BASE, config.businessAccountId, config.phoneNumberId, customer])}`
}

async function updateWindow(
  host: ChannelHost,
  key: string,
  until: number
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previous = await host.state.get(key)
    const previousUntil = previous ? z.number().int().parse(previous.value) : 0
    if (previousUntil >= until) {
      return
    }

    const result = await host.state.compareAndSet({
      key,
      expectedVersion: previous?.version ?? null,
      value: until
    })

    if (result.status === 'updated') {
      return
    }
  }
  throw new Error('window_conflict')
}

async function receiveMessage(
  host: ChannelHost,
  account: AccountConfig,
  config: WhatsAppConfig,
  message: z.infer<typeof messageSchema>,
  signal: AbortSignal
): Promise<void> {
  if (!account.allowedSenders.includes(message.from)) {
    host.observe.log('info', 'channel_policy_rejection', {
      errorCode: 'sender_not_allowed'
    })
    return
  }
  const timestamp = Number(message.timestamp) * 1000
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now() + 300_000) {
    throw new Error('invalid_timestamp')
  }
  const windowUntil = timestamp + 86_400_000
  await updateWindow(host, windowKey(config, message.from), windowUntil)
  const media = await receiveMedia(message, host, config, signal)
  if (!media.text && media.attachments.length === 0) {
    host.observe.log('debug', 'channel_event_ignored', {
      errorCode: 'unsupported_or_empty_text'
    })
    return
  }
  await ingest(host, {
    source: { channel: 'whatsapp', accountId: account.id, eventId: message.id },
    senderId: message.from,
    text: media.text,
    ...(media.attachments.length > 0 ? { attachments: media.attachments } : {}),
    receivedAt: Date.now(),
    context: null,
    target: {
      channel: 'whatsapp',
      accountId: account.id,
      chatId: message.from,
      replyToId: message.id,
      data: {
        phoneNumberId: config.phoneNumberId,
        businessAccountId: config.businessAccountId,
        apiBase: API_BASE,
        customer: message.from,
        windowUntil
      }
    }
  })
}

async function receive(
  host: ChannelHost,
  account: AccountConfig,
  config: WhatsAppConfig,
  body: z.infer<typeof webhookSchema>,
  signal: AbortSignal
): Promise<void> {
  for (const entry of body.entry) {
    if (entry.id !== config.businessAccountId) {
      throw new Error('wrong_business_account')
    }
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        continue
      }
      if (change.value.metadata.phone_number_id !== config.phoneNumberId) {
        throw new Error('wrong_phone_account')
      }
      for (const message of change.value.messages ?? []) {
        await receiveMessage(host, account, config, message, signal)
      }
    }
  }
}

export function createWhatsAppChannel(): ChannelPlugin<WhatsAppConfig> {
  let runtime:
    | { host: ChannelHost; account: AccountConfig; config: WhatsAppConfig }
    | undefined

  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== 'whatsapp'
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const { host, config } = runtime
    const parsed = targetSchema.safeParse(input.target.data)
    if (!parsed.success) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    const target = parsed.data
    if (
      target.customer !== input.target.chatId ||
      target.phoneNumberId !== config.phoneNumberId
    ) {
      return { status: 'rejected', errorCode: 'invalid_target' }
    }
    if (
      target.businessAccountId !== config.businessAccountId ||
      target.apiBase !== API_BASE
    ) {
      return { status: 'rejected', errorCode: 'target_identity_changed' }
    }
    const latest = await host.state.get(windowKey(config, target.customer))

    const until = latest ? z.number().int().parse(latest.value) : 0

    if (Date.now() >= until) {
      return { status: 'rejected', errorCode: 'customer_window_expired' }
    }
    try {
      const media = input.media ? await uploadMedia(input, config) : undefined
      if (media && 'status' in media) {
        return media
      }

      const content = media
        ? { type: media.type, [media.type]: media.value }
        : {
            type: 'text',
            text: {
              body: whatsAppMarkdown(input.chunk.text),
              preview_url: false
            }
          }

      const response = await request(
        validateEndpointUrl(
          `${API_BASE}/${API_VERSION}/${encodeURIComponent(target.phoneNumberId)}/messages`,
          false
        ),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secret(config.accessToken)}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: target.customer,
            ...content
          })
        },
        input.signal
      )

      if (!response.ok) {
        return failure(response)
      }
      const decoded = responseSchema.parse(await response.json())
      const message = decoded.messages[0]
      if (!message) {
        return unavailable()
      }
      return { status: 'sent', receipt: { platformMessageId: message.id } }
    } catch {
      return unavailable()
    }
  }

  return {
    id: 'channel-whatsapp',
    sdkMajor: 1,
    runtime: 'node',
    kind: 'channel',
    channel: 'whatsapp',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 4096,
      lengthUnit: 'utf16',
      idempotentSend: false,
      media: {
        receive: ['image', 'audio', 'video', 'file'],
        send: ['image', 'audio', 'video', 'file']
      }
    },
    validateConfig,
    async resolveChannel(address) {
      if (
        !runtime ||
        address.platform !== 'whatsapp' ||
        address.accountId !== runtime.account.id ||
        !platformIdSchema.safeParse(address.chatId).success ||
        address.threadId !== undefined
      ) {
        return { status: 'unavailable', reason: 'invalid_address' }
      }
      const { host, config } = runtime
      const latest = await host.state.get(windowKey(config, address.chatId))
      const window = z.number().int().nonnegative().safeParse(latest?.value)
      if (!window.success || Date.now() >= window.data) {
        return { status: 'unavailable', reason: 'customer_window_expired' }
      }
      return {
        status: 'available',
        target: {
          channel: 'whatsapp',
          accountId: address.accountId,
          chatId: address.chatId,
          data: {
            phoneNumberId: config.phoneNumberId,
            businessAccountId: config.businessAccountId,
            apiBase: API_BASE,
            customer: address.chatId,
            windowUntil: window.data
          }
        }
      }
    },
    splitText: splitWhatsAppMarkdown,
    async setup(host, account, config) {
      runtime = { host, account, config }
      host.mountHttp('/webhook', async (incoming) => {
        if (incoming.method === 'GET') {
          const query = new URL(incoming.url).searchParams
          if (
            query.get('hub.mode') !== 'subscribe' ||
            query.get('hub.verify_token') !== secret(config.verifyToken)
          ) {
            return new Response(null, { status: 403 })
          }
          const challenge = query.get('hub.challenge')
          return challenge
            ? new Response(challenge)
            : new Response(null, { status: 400 })
        }
        if (incoming.method !== 'POST') {
          return new Response(null, { status: 405 })
        }
        const bytes = await rawBody(incoming)
        if (
          !signed(
            bytes,
            incoming.headers.get('x-hub-signature-256'),
            secret(config.appSecret),
            'hex',
            'sha256='
          )
        ) {
          return new Response(null, { status: 401 })
        }
        const decoded = webhookSchema.safeParse(parseBody(bytes))
        if (!decoded.success) {
          return new Response(null, { status: 400 })
        }
        await receive(host, account, config, decoded.data, incoming.signal)
        return Response.json({})
      })
    },
    send
  }
}
