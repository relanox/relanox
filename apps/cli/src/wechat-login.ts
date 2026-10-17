import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Command } from 'commander'
import { z } from 'zod'
import type {
  WechatLoginStatus,
  WechatLoginOptions as TransportOptions
} from '@relanox/channel-wechat'

const defaultOrigin = 'https://ilinkai.weixin.qq.com'

export class WechatLoginError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WechatLoginError'
  }
}

export type WechatLoginOptions = {
  readonly output: string
  readonly apiBaseUrl?: string
  readonly allowInsecureLoopback?: boolean
  readonly verificationCodeFile?: string | undefined
  readonly signal: AbortSignal
  outputEvent(value: Record<string, unknown>): void
}

/** Region redirects must stay on the selected origin or WeChat's own hosts. */
function loginOrigin(value: string, initial: string): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new WechatLoginError('wechat_login_origin_invalid')
  }
  if (url.origin === initial) {
    return url.origin
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    !(
      url.hostname === 'weixin.qq.com' ||
      url.hostname.endsWith('.weixin.qq.com')
    )
  ) {
    throw new WechatLoginError('wechat_login_origin_invalid')
  }
  return url.origin
}

async function verificationCode(
  path: string | undefined
): Promise<string | undefined> {
  if (!path) {
    return undefined
  }
  try {
    return z
      .string()
      .regex(/^\d{4,12}$/u)
      .parse((await readFile(path, 'utf8')).trim())
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw new WechatLoginError('wechat_verification_code_invalid')
  }
}

async function pollLogin(
  options: TransportOptions & { qrcode: string; verifyCode?: string }
): Promise<WechatLoginStatus> {
  const { pollWechatLogin, WechatLoginHttpError } =
    await import('@relanox/channel-wechat')

  for (let attempt = 0; ; attempt++) {
    try {
      return await pollWechatLogin(options)
    } catch (error) {
      options.signal.throwIfAborted()

      const temporary =
        error instanceof Error &&
        (error.name === 'TimeoutError' ||
          error instanceof TypeError ||
          (error instanceof WechatLoginHttpError &&
            [429, 500, 502, 503, 504].includes(error.status)))

      if (!temporary || attempt >= 2) {
        throw error
      }
      await delay(1000, undefined, { signal: options.signal })
    }
  }
}

async function authenticate(options: WechatLoginOptions): Promise<{
  botId: string
  botToken: string
  apiBaseUrl: string
  userId: string
}> {
  const { beginWechatLogin } = await import('@relanox/channel-wechat')

  const initial = new URL(options.apiBaseUrl ?? defaultOrigin).origin
  let apiBaseUrl = loginOrigin(options.apiBaseUrl ?? defaultOrigin, initial)

  const transport = {
    allowInsecureLoopback: options.allowInsecureLoopback ?? false,
    signal: options.signal
  }

  const qr = await beginWechatLogin({ ...transport, apiBaseUrl })
  options.outputEvent({ event: 'wechat_qrcode', qrCode: qr.qrcode_img_content })
  let previousStatus: string | undefined
  let needsCode = false
  let submittedCode: string | undefined
  while (!options.signal.aborted) {
    const code = needsCode
      ? await verificationCode(options.verificationCodeFile)
      : undefined

    if (needsCode && (!code || code === submittedCode)) {
      await delay(1000, undefined, { signal: options.signal })
      continue
    }
    if (code) {
      submittedCode = code
    }

    const result = await pollLogin({
      ...transport,
      apiBaseUrl,
      qrcode: qr.qrcode,
      ...(code ? { verifyCode: code } : {})
    })

    if (result.status === 'confirmed') {
      return {
        botId: result.ilink_bot_id,
        botToken: result.bot_token,
        apiBaseUrl: loginOrigin(result.baseurl, initial),
        userId: result.ilink_user_id
      }
    }
    if (result.status !== previousStatus) {
      options.outputEvent({
        event: 'wechat_login_status',
        status: result.status
      })
      previousStatus = result.status
    }
    if (result.status === 'scaned_but_redirect' && result.redirect_host) {
      apiBaseUrl = loginOrigin(`https://${result.redirect_host}`, initial)
    }
    if (
      ['expired', 'verify_code_blocked', 'binded_redirect'].includes(
        result.status
      )
    ) {
      throw new WechatLoginError(`wechat_login_${result.status}`)
    }
    needsCode = result.status === 'need_verifycode'
    if (needsCode && code) {
      options.outputEvent({ event: 'wechat_verification_code_rejected' })
    }
    if (needsCode && !options.verificationCodeFile) {
      throw new WechatLoginError('wechat_verification_code_file_required')
    }
    await delay(1000, undefined, { signal: options.signal })
  }
  options.signal.throwIfAborted()
  throw new WechatLoginError('wechat_login_cancelled')
}

/** Reserve a new private file before pairing, so an existing credential is never replaced. */
export async function loginWechat(options: WechatLoginOptions): Promise<void> {
  options.signal.throwIfAborted()
  const path = resolve(options.output)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new WechatLoginError('wechat_credentials_file_exists')
    }
    throw error
  })

  let saved = false
  try {
    const credentials = await authenticate(options)
    await file.writeFile(
      `${JSON.stringify(credentials, undefined, 2)}\n`,
      'utf8'
    )
    await file.sync()
    saved = true
    options.outputEvent({
      ok: true,
      event: 'wechat_login_complete',
      credentialsFile: path,
      botId: credentials.botId,
      userId: credentials.userId,
      apiBaseUrl: credentials.apiBaseUrl
    })
  } finally {
    await file.close()
    if (!saved) {
      await unlink(path)
    }
  }
}

export function addWechatLogin(program: Command): void {
  program
    .command('wechat-login')
    .description(
      'Pair WeChat by QR code and save credentials to a new private JSON file'
    )
    .requiredOption(
      '--output <path>',
      'New credential file; existing files are never overwritten'
    )
    .option('--api-base-url <url>', 'WeChat iLink API origin', defaultOrigin)
    .option(
      '--verification-code-file <path>',
      'Read a phone verification code from this file if requested'
    )
    .option('--timeout <seconds>', 'Pairing deadline in seconds', '180')
    .action(async (raw: unknown) => {
      const options = z
        .object({
          output: z.string().min(1),
          apiBaseUrl: z.url(),
          verificationCodeFile: z.string().min(1).optional(),
          timeout: z.coerce.number().int().min(1).max(600)
        })
        .parse(raw)

      const { default: qr } = await import('qrcode-terminal')
      const controller = new AbortController()

      const stop = (): void => {
        controller.abort()
      }

      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      try {
        await loginWechat({
          ...options,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(options.timeout * 1000)
          ]),
          outputEvent(value) {
            process.stdout.write(`${JSON.stringify(value)}\n`)
            if (
              value.event === 'wechat_qrcode' &&
              typeof value.qrCode === 'string'
            ) {
              qr.generate(value.qrCode, { small: true }, (rendered) => {
                process.stderr.write(`${rendered}\n`)
              })
            }
          }
        })
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
    })
}
