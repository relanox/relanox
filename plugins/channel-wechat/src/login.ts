import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { transportUrl } from './config.js'
import { readJson } from './json.js'

export type WechatLoginOptions = {
  readonly apiBaseUrl?: string
  readonly allowInsecureLoopback?: boolean
  readonly signal: AbortSignal
}

const qrSchema = z.object({
  qrcode: z.string().min(1),
  qrcode_img_content: z.string().min(1)
})

const statusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('confirmed'),
    bot_token: z.string().min(1),
    ilink_bot_id: z.string().min(1),
    baseurl: z.string(),
    ilink_user_id: z.string().min(1)
  }),
  z.object({
    status: z.literal('scaned_but_redirect'),
    redirect_host: z.string().optional()
  }),
  z.object({
    status: z.enum([
      'wait',
      'scaned',
      'expired',
      'need_verifycode',
      'verify_code_blocked',
      'binded_redirect'
    ])
  })
])

export type WechatLoginStatus = z.infer<typeof statusSchema>

function loginUrl(options: WechatLoginOptions, path: string): URL {
  const base = transportUrl(
    options.apiBaseUrl ?? 'https://ilinkai.weixin.qq.com',
    options.allowInsecureLoopback ?? false
  )

  return new URL(`${base.href.replace(/\/$/u, '')}/ilink/bot/${path}`)
}

/** Obtain QR content for an interactive login. Credentials never enter plugin state or logs. */
export async function beginWechatLogin(
  options: WechatLoginOptions
): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const url = loginUrl(options, 'get_bot_qrcode')
  url.searchParams.set('bot_type', '3')

  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(
        String(randomBytes(4).readUInt32BE())
      ).toString('base64'),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '256'
    },
    body: JSON.stringify({ local_token_list: [] })
  })

  if (!response.ok) {
    throw new Error('wechat_login_failed')
  }
  return qrSchema.parse(await readJson(response))
}

/** Poll once; caller owns interaction, retries, verification and credential storage. */
export async function pollWechatLogin(
  options: WechatLoginOptions & {
    readonly qrcode: string
    readonly verifyCode?: string
  }
): Promise<WechatLoginStatus> {
  const url = loginUrl(options, 'get_qrcode_status')
  url.searchParams.set('qrcode', options.qrcode)
  if (options.verifyCode !== undefined) {
    url.searchParams.set('verify_code', options.verifyCode)
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]),
    headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256' }
  })

  if (!response.ok) {
    throw new Error('wechat_login_failed')
  }
  const status = statusSchema.parse(await readJson(response))
  if (status.status === 'confirmed') {
    transportUrl(status.baseurl, options.allowInsecureLoopback ?? false)
  }
  return status
}
