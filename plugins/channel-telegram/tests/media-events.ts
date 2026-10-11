import { createHash, createHmac } from 'node:crypto'
import type { Json, MediaKind } from '@relanox/sdk'
import { vi } from 'vitest'
import type { MediaRuntime } from './media-runtime.js'

export type PrimaryChannel =
  'telegram' | 'discord' | 'slack' | 'feishu' | 'line'

export const nativeTargets = {
  telegram: { chat: '456', thread: '8' },
  discord: { chat: '456' },
  slack: { chat: 'C456', thread: '9.1' },
  feishu: { chat: 'oc_456', thread: 'omt_8' },
  line: { chat: '42' }
}

export function channelConfig(
  channel: PrimaryChannel,
  origin: string,
  gateway = 'wss://gateway.discord.gg'
): Json {
  vi.stubEnv(
    'MEDIA_NATIVE_TOKEN',
    channel === 'telegram' ? '123:abc_DEF' : 'native-token'
  )
  vi.stubEnv('MEDIA_NATIVE_SECRET', 'native-secret')
  vi.stubEnv('MEDIA_NATIVE_ENCRYPT', 'native-encrypt')
  switch (channel) {
    case 'telegram': {
      return {
        botToken: { env: 'MEDIA_NATIVE_TOKEN' },
        webhookSecret: { env: 'MEDIA_NATIVE_SECRET' },
        apiBaseUrl: origin,
        allowInsecureLoopback: true,
        timeoutMs: 2000
      }
    }
    case 'discord': {
      return {
        botToken: { env: 'MEDIA_NATIVE_TOKEN' },
        botUserId: '999',
        apiBaseUrl: origin,
        gatewayUrl: gateway,
        allowInsecureLoopback: true,
        timeoutMs: 2000,
        reconnectDelayMs: 100
      }
    }
    case 'slack': {
      return {
        receiveMode: 'http',
        botToken: { env: 'MEDIA_NATIVE_TOKEN' },
        signingSecret: { env: 'MEDIA_NATIVE_SECRET' },
        botUserId: 'U999',
        teamId: 'T999',
        appId: 'A999',
        apiBaseUrl: origin,
        allowInsecureLoopback: true,
        timeoutMs: 2000
      }
    }
    case 'feishu': {
      return {
        appId: 'cli_999',
        appSecret: { env: 'MEDIA_NATIVE_TOKEN' },
        verificationToken: { env: 'MEDIA_NATIVE_SECRET' },
        encryptKey: { env: 'MEDIA_NATIVE_ENCRYPT' },
        botOpenId: 'ou_999',
        tenantKey: 'tenant999',
        apiBaseUrl: origin,
        allowInsecureLoopback: true,
        timeoutMs: 2000
      }
    }
    case 'line': {
      return {
        botUserId: 'U999',
        accessToken: { env: 'MEDIA_NATIVE_TOKEN' },
        channelSecret: { env: 'MEDIA_NATIVE_SECRET' },
        apiBase: origin,
        contentApiBase: origin,
        allowLoopback: true
      }
    }
  }
  throw new Error('unsupported_test_channel')
}

export function telegramMessage(
  kind: MediaKind,
  size: number,
  mimeType: string,
  caption = ''
) {
  const file = {
    file_id: 'native-file',
    file_size: size,
    file_name: 'incoming.bin',
    mime_type: mimeType,
    duration: 1
  }

  return {
    update_id: 700,
    message: {
      message_id: 9,
      message_thread_id: 8,
      from: { id: 42, is_bot: false },
      chat: { id: 456, type: 'supergroup' },
      ...(caption ? { caption } : {}),
      ...(kind === 'image'
        ? { photo: [file] }
        : {
            [{ audio: 'audio', video: 'video', file: 'document' }[kind]]: file
          })
    }
  }
}

function feishuContent(kind: MediaKind, caption: string) {
  if (caption) {
    return {
      zh_cn: {
        content: [
          [
            { tag: 'text', text: caption },
            { tag: 'img', image_key: 'img_700' }
          ]
        ]
      }
    }
  }
  if (kind === 'image') {
    return { image_key: 'img_700' }
  }
  return { file_key: 'file_700', file_name: 'incoming.bin', duration: 1000 }
}

export async function httpIngress(
  runtime: MediaRuntime,
  channel: Exclude<PrimaryChannel, 'discord'>,
  kind: MediaKind,
  origin: string,
  size: number,
  mimeType: string,
  caption = ''
) {
  let value: unknown
  let path = '/webhook'

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    connection: 'close'
  }

  if (channel === 'telegram') {
    value = telegramMessage(kind, size, mimeType, caption)
    headers['x-telegram-bot-api-secret-token'] = 'native-secret'
  } else if (channel === 'slack') {
    path = '/events'
    value = {
      type: 'event_callback',
      team_id: 'T999',
      api_app_id: 'A999',
      event_id: 'EV700',
      event: {
        type: 'message',
        subtype: 'file_share',
        channel: 'C456',
        user: '42',
        ts: '9.1',
        text: caption,
        files: [
          {
            id: 'F700',
            name: 'incoming.bin',
            mimetype: mimeType,
            size,
            url_private_download: `${origin}/asset`
          }
        ]
      }
    }
  } else if (channel === 'feishu') {
    path = '/events'
    value = {
      schema: '2.0',
      header: {
        token: 'native-secret',
        app_id: 'cli_999',
        tenant_key: 'tenant999',
        event_type: 'im.message.receive_v1',
        event_id: 'EV700'
      },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: '42' } },
        message: {
          message_id: 'om_9',
          chat_id: 'oc_456',
          chat_type: 'group',
          message_type: caption
            ? 'post'
            : { image: 'image', audio: 'audio', video: 'media', file: 'file' }[
                kind
              ],
          content: JSON.stringify(feishuContent(kind, caption)),
          create_time: '1000',
          thread_id: 'omt_8'
        }
      }
    }
  } else {
    value = {
      destination: 'U999',
      events: [
        {
          type: 'message',
          webhookEventId: 'EV700',
          source: { type: 'user', userId: '42' },
          message: {
            id: '700',
            type: kind,
            fileName: 'incoming.bin',
            fileSize: size,
            duration: 1000,
            contentProvider: { type: 'line' }
          }
        }
      ]
    }
  }
  const body = JSON.stringify(value)
  const timestamp = String(Math.floor(Date.now() / 1000))
  if (channel === 'slack') {
    headers['x-slack-request-timestamp'] = timestamp
    headers['x-slack-signature'] =
      `v0=${createHmac('sha256', 'native-secret').update(`v0:${timestamp}:`).update(body).digest('hex')}`
  }
  if (channel === 'feishu') {
    headers['x-lark-request-timestamp'] = timestamp
    headers['x-lark-request-nonce'] = 'media-nonce'
    headers['x-lark-signature'] = createHash('sha256')
      .update(`${timestamp}media-noncenative-encrypt`)
      .update(body)
      .digest('hex')
  }
  if (channel === 'line') {
    headers['x-line-signature'] = createHmac('sha256', 'native-secret')
      .update(body)
      .digest('base64')
  }
  return fetch(`${runtime.businessUrl}/channels/business${path}`, {
    method: 'POST',
    headers,
    body
  })
}
