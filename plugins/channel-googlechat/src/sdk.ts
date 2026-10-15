import { chat_v1 } from '@googleapis/chat'
import { gaxios, OAuth2Client } from 'google-auth-library'
import type { SendResult } from '@relanox/sdk'
import type { GoogleChatConfig } from './config.js'
import { invalidateAccessToken } from './client.js'
import { failure, request, unavailable } from './io.js'

export { accessToken } from './client.js'
export type { chat_v1 } from '@googleapis/chat'

// Keep the official generated client responsible for the REST protocol. Core
// Schedules delivery retries; the SDK must not replay an ambiguous message POST.
const transportOptions = {
  retry: false,
  retryConfig: { retry: 0 },
  timeout: 10_000,
  fetchImplementation: async (
    url: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const address = url instanceof Request ? url.url : url
    return request(new URL(address), init ?? {}, init?.signal ?? undefined)
  }
}

export const chatClient = new chat_v1.Chat(transportOptions)

export function chatVerifier(): OAuth2Client {
  return new OAuth2Client({ transporterOptions: transportOptions })
}

export function sendFailure(
  config: GoogleChatConfig,
  token: string,
  error: unknown
): SendResult {
  if (!(error instanceof gaxios.GaxiosError) || !error.response) {
    return unavailable()
  }
  const { status, headers } = error.response
  if (status === 401) {
    invalidateAccessToken(config, token)
    return { status: 'retryable', errorCode: 'oauth_token_rejected' }
  }
  return failure(new Response(null, { status, headers }))
}
