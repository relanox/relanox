import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import {
  httpPeer,
  json
} from '../../../plugins/channel-matrix/tests/harness.js'
import { loginWechat } from '../src/wechat-login.js'

// The CLI protects credential files and controls region redirects; plugin tests
// Only cover individual HTTP calls. Replacing an existing token or following an
// Unrelated redirect would break this public login workflow. Real HTTP/filesystem,
// No extra production seam. Wire fields: Tencent's src/auth/login-qr.ts at
// https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
})

async function outputPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-wechat-login-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  return join(directory, 'credentials.json')
}

it('survives a temporary gateway failure and saves confirmed credentials without printing the token', async () => {
  const output = await outputPath()
  const events: Record<string, unknown>[] = []
  let qrCalls = 0
  let pollCalls = 0

  const peer = await httpPeer((request, response) => {
    if (request.method === 'POST') {
      qrCalls++
      json(response, {
        qrcode: 'qr-handle',
        qrcode_img_content: 'https://weixin.qq.com/login/qr'
      })
    } else {
      pollCalls++
      if (pollCalls === 1) {
        response.writeHead(502)
        response.end()
        return
      }
      json(response, {
        status: 'confirmed',
        bot_token: 'private-bot-token',
        ilink_bot_id: 'bot@im.bot',
        ilink_user_id: 'owner@im.wechat',
        baseurl: peer.base
      })
    }
  })

  await loginWechat({
    output,
    apiBaseUrl: peer.base,
    allowInsecureLoopback: true,
    signal: new AbortController().signal,
    outputEvent: (event) => events.push(event)
  })
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
    botId: 'bot@im.bot',
    botToken: 'private-bot-token',
    apiBaseUrl: peer.base,
    userId: 'owner@im.wechat'
  })
  expect(events).toContainEqual({
    ok: true,
    event: 'wechat_login_complete',
    credentialsFile: output,
    botId: 'bot@im.bot',
    userId: 'owner@im.wechat',
    apiBaseUrl: peer.base
  })
  expect(JSON.stringify(events)).not.toContain('private-bot-token')
  expect(qrCalls).toBe(1)
  expect(pollCalls).toBe(2)
  if (process.platform !== 'win32') {
    expect((await stat(output)).mode & 0o777).toBe(0o600)
  }
})

it('refuses an existing credential file before contacting the platform', async () => {
  const output = await outputPath()
  await writeFile(output, 'existing credentials')
  let calls = 0

  const peer = await httpPeer((_request, response) => {
    calls++
    json(response, {})
  })

  await expect(
    loginWechat({
      output,
      apiBaseUrl: peer.base,
      allowInsecureLoopback: true,
      signal: new AbortController().signal,
      outputEvent() {}
    })
  ).rejects.toMatchObject({ code: 'wechat_credentials_file_exists' })
  expect(calls).toBe(0)
  expect(await readFile(output, 'utf8')).toBe('existing credentials')
})

it('rejects an unrelated QR redirect and removes only its newly reserved empty file', async () => {
  const output = await outputPath()

  const peer = await httpPeer((request, response) => {
    json(
      response,
      request.method === 'POST'
        ? {
            qrcode: 'qr-handle',
            qrcode_img_content: 'https://weixin.qq.com/login/qr'
          }
        : { status: 'scaned_but_redirect', redirect_host: 'example.com' }
    )
  })

  await expect(
    loginWechat({
      output,
      apiBaseUrl: peer.base,
      allowInsecureLoopback: true,
      signal: new AbortController().signal,
      outputEvent() {}
    })
  ).rejects.toMatchObject({ code: 'wechat_login_origin_invalid' })
  await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
})

// A rejected code must wait for user correction, not consume the platform's
// Remaining attempts automatically. Single-call plugin tests cannot detect this loop.
it('waits for a changed verification code after rejection', async () => {
  const output = await outputPath()
  const codePath = `${output}.code`
  await writeFile(codePath, '1111')
  const attempts: string[] = []
  const rejected = Promise.withResolvers<void>()

  const peer = await httpPeer((request, response) => {
    const url = new URL(request.url ?? '/', peer.base)
    if (request.method === 'POST') {
      json(response, {
        qrcode: 'qr-handle',
        qrcode_img_content: 'https://weixin.qq.com/login/qr'
      })
      return
    }
    const code = url.searchParams.get('verify_code')
    if (code) {
      attempts.push(code)
    }
    json(
      response,
      code === '2222'
        ? {
            status: 'confirmed',
            bot_token: 'private-token',
            ilink_bot_id: 'bot@im.bot',
            ilink_user_id: 'owner@im.wechat',
            baseurl: peer.base
          }
        : { status: 'need_verifycode' }
    )
  })

  const login = loginWechat({
    output,
    apiBaseUrl: peer.base,
    allowInsecureLoopback: true,
    verificationCodeFile: codePath,
    signal: AbortSignal.timeout(10_000),
    outputEvent(event) {
      if (event.event === 'wechat_verification_code_rejected') {
        rejected.resolve()
      }
    }
  })

  await rejected.promise
  await delay(1100)
  expect(attempts).toEqual(['1111'])
  await writeFile(codePath, '2222')
  await login
  expect(attempts).toEqual(['1111', '2222'])
})
