import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Json } from '@relanox/sdk'
import type { WechatConfig } from './config.js'
import { ApiError } from './errors.js'
import { readJson } from './json.js'

// Wire model verified against Tencent's published iLink protocol and API types:
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
// Numbering belongs to the protocol; voice=3 is distinct from upload media_type=4.
const mediaSchema = z.object({
  encrypt_query_param: z.string().optional(),
  aes_key: z.string().optional(),
  encrypt_type: z.number().optional(),
  full_url: z.string().optional()
})

const contentSchema = z.object({
  media: mediaSchema.optional(),
  aeskey: z.string().optional(),
  text: z.string().optional(),
  file_name: z.string().optional(),
  playtime: z.number().optional(),
  encode_type: z.number().optional()
})

export const itemSchema = z.object({
  type: z.number().int(),
  msg_id: z.union([z.string(), z.number().int()]).optional(),
  text_item: z.object({ text: z.string().optional() }).optional(),
  image_item: contentSchema.optional(),
  voice_item: contentSchema.optional(),
  file_item: contentSchema.optional(),
  video_item: contentSchema.optional()
})

export const messageSchema = z.object({
  // The published table says number; current official types use lossless uint64 strings.
  message_id: z
    .union([z.string().regex(/^\d+$/u), z.number().int()])
    .optional(),
  client_id: z.string().optional(),
  seq: z.number().int().optional(),
  from_user_id: z.string().optional(),
  to_user_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number().optional(),
  message_state: z.number().optional(),
  create_time_ms: z.number().nonnegative().optional(),
  context_token: z.string().optional(),
  item_list: z.array(itemSchema).default([])
})

export const resultSchema = z.object({
  ret: z.number().optional(),
  errcode: z.number().optional()
})

export const updatesSchema = resultSchema.extend({
  msgs: z.array(messageSchema).default([]),
  get_updates_buf: z.string().optional(),
  longpolling_timeout_ms: z.number().optional()
})

export const contextSchema = z.object({
  botId: z.string(),
  apiBaseUrl: z.string(),
  contextToken: z.string().min(1)
})

export type WechatMessage = z.infer<typeof messageSchema>
export type WechatItem = z.infer<typeof itemSchema>

export class WechatClient {
  constructor(
    readonly config: WechatConfig,
    private readonly environment: Readonly<Record<string, string | undefined>>
  ) {}

  async post(
    path: string,
    body: Readonly<Record<string, Json>>,
    signal: AbortSignal,
    timeoutMs = 15_000
  ): Promise<unknown> {
    const token = this.environment[this.config.botToken.env]

    if (!token || /[\r\n]/u.test(token)) {
      throw new Error('missing_bot_token')
    }

    const response = await fetch(
      `${this.config.apiBaseUrl.replace(/\/$/u, '')}/ilink/bot/${path}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${token}`,
          'X-WECHAT-UIN': Buffer.from(
            String(randomBytes(4).readUInt32BE())
          ).toString('base64'),
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '256'
        },
        body: JSON.stringify({
          ...body,
          base_info: { channel_version: '0.1.0', bot_agent: 'Relanox/0.1.0' }
        })
      }
    )

    if (!response.ok) {
      throw new ApiError(response.status, response.status)
    }
    const raw = await readJson(response)
    const result = resultSchema.parse(raw)

    if (result.ret === -14 || result.errcode === -14) {
      throw new ApiError(-14)
    }

    const errorCode =
      result.ret === undefined || result.ret === 0 ? result.errcode : result.ret

    if (errorCode) {
      throw new ApiError(errorCode)
    }
    return raw
  }
}
