import type { SendResult } from '@relanox/sdk'
import { gaxios, JWT } from 'google-auth-library'
import type { GoogleChatConfig } from './config.js'
import { failure, request, secret } from './io.js'
import { serviceSchema } from './schemas.js'

const clients = new WeakMap<
  GoogleChatConfig,
  { credential: string; client: JWT }
>()

function authClient(config: GoogleChatConfig): JWT {
  const credential = secret(config.serviceAccount)
  const cached = clients.get(config)
  if (cached?.credential === credential) {
    return cached.client
  }
  const service = serviceSchema.parse(JSON.parse(credential) as unknown)

  const client = new JWT({
    email: service.client_email,
    key: service.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
    transporterOptions: {
      retry: false,
      // Gtoken supplies its own retryConfig, which gaxios treats as enabling
      // Retries even when retry is false. Core owns retry scheduling.
      retryConfig: { retry: 0 },
      timeout: 10_000,
      // Keep the SDK's token cache/refresh while preserving the relay's
      // Bounded transport and refusal to follow credential-bearing redirects.
      fetchImplementation: async (url, init): Promise<Response> => {
        const address = url instanceof Request ? url.url : url
        return request(new URL(address), init ?? {})
      }
    }
  })

  clients.set(config, { credential, client })
  return client
}

async function tokenWithSignal(
  client: JWT,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined

  const canceled = new Promise<never>((_resolve, reject) => {
    abort = (): void => {
      reject(new Error('oauth_canceled', { cause: signal.reason }))
    }
    signal.addEventListener('abort', abort, { once: true })
  })

  try {
    // Cancel only this caller; a shared refresh remains available to other
    // Sends and is independently bounded by the transport timeout.
    const result = await Promise.race([client.getAccessToken(), canceled])
    if (
      typeof result.token !== 'string' ||
      !result.token ||
      !Number.isFinite(client.credentials.expiry_date)
    ) {
      throw new Error('invalid_oauth_token')
    }
    return result.token
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort)
    }
  }
}

export function invalidateAccessToken(
  config: GoogleChatConfig,
  token: string
): void {
  // An older failed request must not discard a token refreshed by another send.
  if (clients.get(config)?.client.credentials.access_token === token) {
    clients.delete(config)
  }
}

export async function accessToken(
  config: GoogleChatConfig,
  signal: AbortSignal
): Promise<string | SendResult> {
  try {
    return await tokenWithSignal(authClient(config), signal)
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_oauth_token') {
      clients.delete(config)
    }
    if (error instanceof gaxios.GaxiosError && error.response) {
      const { status, headers } = error.response
      return status >= 500
        ? { status: 'retryable', errorCode: 'oauth_unavailable' }
        : failure(new Response(null, { status, headers }))
    }
    return { status: 'retryable', errorCode: 'oauth_unavailable' }
  }
}
