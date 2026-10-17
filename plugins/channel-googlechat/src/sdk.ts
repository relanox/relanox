import { chat } from '@googleapis/chat'
import type { chat_v1 } from '@googleapis/chat'
import { gaxios, JWT, OAuth2Client } from 'google-auth-library'
import type { SendResult } from '@relanox/sdk'
import type { GoogleChatConfig } from './config.js'
import { failure, secret, unavailable } from './io.js'
import { serviceSchema } from './schemas.js'

export type { chat_v1 } from '@googleapis/chat'

// Google-auth-library 11.1.0 gtoken supplies a retryConfig of its own. Disable
// Both retry controls so Core alone decides whether to repeat a message POST.
const transportOptions = {
  retry: false,
  retryConfig: { retry: 0 },
  timeout: 10_000,
  redirect: 'error' as const,
  // Use Node's native fetch for the SDK transport, without a second HTTP layer.
  fetchImplementation: async (
    url: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => fetch(url, init)
}

const clients = new WeakMap<
  GoogleChatConfig,
  {
    credential: string
    client: chat_v1.Chat
  }
>()

export function chatClient(config: GoogleChatConfig): chat_v1.Chat {
  const credential = secret(config.serviceAccount)
  const cached = clients.get(config)
  if (cached?.credential === credential) {
    return cached.client
  }
  const service = serviceSchema.parse(JSON.parse(credential) as unknown)

  const auth = new JWT({
    email: service.client_email,
    key: service.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
    transporterOptions: transportOptions
  })

  // Validate the external OAuth boundary without replacing SDK refresh/cache.
  auth.on('tokens', (tokens) => {
    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      !Number.isFinite(tokens.expiry_date)
    ) {
      throw new Error('invalid_oauth_token')
    }
  })
  const client = chat({ version: 'v1', auth, ...transportOptions })
  clients.set(config, { credential, client })
  return client
}

export function chatVerifier(): OAuth2Client {
  return new OAuth2Client({ transporterOptions: transportOptions })
}

export function sendFailure(
  config: GoogleChatConfig,
  error: unknown,
  started: boolean
): SendResult {
  const response =
    error instanceof gaxios.GaxiosError ? error.response : undefined

  if (!started) {
    clients.delete(config)
    return response && response.status < 500
      ? failure(response)
      : { status: 'retryable', errorCode: 'oauth_unavailable' }
  }
  if (response?.status === 401) {
    clients.delete(config)
    return { status: 'retryable', errorCode: 'oauth_token_rejected' }
  }
  return response ? failure(response) : unavailable()
}

export function rejectMediaToken(
  config: GoogleChatConfig,
  status: number
): void {
  if (status === 401) {
    clients.delete(config)
  }
}
