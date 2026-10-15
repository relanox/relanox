import {
  createLarkChannel,
  defaultHttpInstance,
  DefaultCache,
  CTenantAccessToken,
  LarkChannelError
} from '@larksuiteoapi/node-sdk'
import type { HttpInstance, LarkChannel } from '@larksuiteoapi/node-sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SendResult } from '@relanox/sdk'
import { z } from 'zod'
import { REQUEST_TIMEOUT_MS } from './config.js'
import type { FeishuConfig } from './config.js'
import { credential } from './transport.js'

class PlatformError extends LarkChannelError {
  override readonly name = 'PlatformError'

  constructor(readonly result: SendResult) {
    // SDK fallback must not turn an explicit native reply into an ordinary send.
    super('unknown', 'feishu_request_failed')
  }
}

const nativeErrorSchema = z.object({ code: z.number().int() })

const responseErrorSchema = z.object({
  response: z.object({
    status: z.number(),
    data: z.unknown(),
    headers: z.object({ 'retry-after': z.coerce.number().optional() })
  })
})

/** The SDK owns requests and token caching; this boundary owns Core outcomes. */
export function createSdk(
  config: FeishuConfig,
  environment: NodeJS.ProcessEnv
): {
  channel: LarkChannel
  invalidateToken(): Promise<void>
  stop(): Promise<void>
  run(signal: AbortSignal, send: () => Promise<SendResult>): Promise<SendResult>
} {
  const cache = new DefaultCache()
  const lifetime = new AbortController()

  const context = new AsyncLocalStorage<{
    signal: AbortSignal
    messageAttempted: boolean
  }>()

  const http = defaultHttpInstance.create({
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
    proxy: false
  })

  const invalidateToken = async (): Promise<void> => {
    await cache.set(CTenantAccessToken, '', 1, { namespace: config.appId })
  }

  function result(
    status: number,
    body: unknown,
    retryAfter?: number
  ): SendResult {
    if (status === 429) {
      return {
        status: 'retryable',
        errorCode: 'rate_limited',
        ...(retryAfter && retryAfter > 0
          ? { retryAfterMs: Math.ceil(retryAfter * 1000) }
          : {})
      }
    }
    const code = nativeErrorSchema.safeParse(body)
    if (status < 500 && code.success && code.data.code === 99_991_663) {
      void invalidateToken()
      return { status: 'retryable', errorCode: 'feishu_token_invalid' }
    }
    return {
      status: status >= 500 ? 'unknown' : 'rejected',
      errorCode: status === 200 ? 'feishu_api_error' : 'platform_http_error'
    }
  }

  http.interceptors.request.use((request) => {
    const active = context.getStore()
    lifetime.signal.throwIfAborted()
    active?.signal.throwIfAborted()
    request.signal = AbortSignal.any([
      lifetime.signal,
      ...(active ? [active.signal] : [])
    ])
    if (
      active &&
      request.method?.toLowerCase() === 'post' &&
      /\/im\/v1\/messages(?:\/|$)/u.test(request.url ?? '')
    ) {
      active.messageAttempted = true
    }
    return request
  })
  http.interceptors.response.use(
    (response) => {
      const body: unknown = response.data
      const parsed = nativeErrorSchema.safeParse(body)
      if (parsed.success && parsed.data.code !== 0) {
        throw new PlatformError(result(response.status, body))
      }
      return body as typeof response
    },
    (error: unknown) => {
      const parsed = responseErrorSchema.safeParse(error)
      if (parsed.success) {
        const { status, data, headers } = parsed.data.response
        throw new PlatformError(result(status, data, headers['retry-after']))
      }
      throw error
    }
  )

  const quiet = (): void => {}

  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: credential(config.appSecret, environment),
    transport: 'webhook',
    domain:
      config.domain === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    cache,
    // The response interceptor unwraps AxiosResponse to the SDK's data-only contract.
    httpInstance: http as unknown as HttpInstance,
    logger: {
      error: quiet,
      warn: quiet,
      info: quiet,
      debug: quiet,
      trace: quiet
    },
    outbound: { retry: { maxAttempts: 1 }, textChunkLimit: 10_000 }
  })

  return {
    channel,
    invalidateToken,
    async stop() {
      lifetime.abort()
      await channel.disconnect()
    },
    async run(signal, send) {
      const active = { signal, messageAttempted: false }
      return context.run(active, async () => {
        try {
          signal.throwIfAborted()
          return await send()
        } catch (error) {
          const failure = platformFailure(error)
          if (failure) {
            return failure.status === 'unknown' && !active.messageAttempted
              ? { status: 'retryable', errorCode: failure.errorCode }
              : failure
          }
          return {
            status: active.messageAttempted ? 'unknown' : 'retryable',
            errorCode: active.messageAttempted
              ? 'feishu_transport_error'
              : 'feishu_prepare_unavailable'
          }
        }
      })
    }
  }
}

function platformFailure(error: unknown): SendResult | undefined {
  if (error instanceof PlatformError) {
    return error.result
  }

  const cause: unknown =
    error instanceof LarkChannelError ? error.cause : undefined

  return cause === undefined ? undefined : platformFailure(cause)
}
