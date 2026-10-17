import {
  WebClient,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIHTTPError,
  LogLevel
} from '@slack/web-api'
import type { WebClientOptions, ChatPostMessageResponse } from '@slack/web-api'
import { readBounded } from '@relanox/transport'
import type { SendResult } from '@relanox/sdk'
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from './config.js'

type UploadState = { publicationAttempted: boolean }

const uploads = new WeakMap<WebClient, UploadState>()
const completionUrl = new URL(`${API_BASE_URL}/files.completeUploadExternal`)

export function sdkOptions(
  signal?: AbortSignal,
  upload?: UploadState
): WebClientOptions {
  return {
    slackApiUrl: `${API_BASE_URL}/`,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    allowAbsoluteUrls: false,
    timeout: REQUEST_TIMEOUT_MS,
    // SDK debug output includes message bodies. Connection reporting belongs to the host.
    logger: {
      getLevel: () => LogLevel.ERROR,
      setLevel() {},
      setName() {},
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    async fetch(url, init) {
      const address = new URL(url)
      if (
        address.protocol !== 'https:' ||
        address.username ||
        address.password ||
        address.hash ||
        !['https://slack.com', 'https://files.slack.com'].includes(
          address.origin
        )
      ) {
        throw new Error('invalid_slack_destination')
      }
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
      if (signal) {
        signals.push(signal)
      }
      if (init?.signal) {
        signals.push(init.signal)
      }
      const bounded = AbortSignal.any(signals)
      bounded.throwIfAborted()

      if (
        upload &&
        init?.method === 'POST' &&
        address.origin === completionUrl.origin &&
        address.pathname === completionUrl.pathname
      ) {
        upload.publicationAttempted = true
      }

      const response = await fetch(url, {
        ...init,
        signal: bounded,
        redirect: 'error'
      })

      const body = await readBounded(response.body)
      return new Response(
        response.status === 204 ? null : new Uint8Array(body),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        }
      )
    }
  }
}

export function createClient(token: string, signal?: AbortSignal): WebClient {
  const upload = { publicationAttempted: false }
  const client = new WebClient(token, sdkOptions(signal, upload))
  uploads.set(client, upload)
  return client
}

export function uploadFailure(client: WebClient, error: unknown): SendResult {
  return sdkFailure(error, uploads.get(client)?.publicationAttempted === false)
}

function apiError(error: string, preparing: boolean): SendResult {
  if (error === 'ratelimited') {
    return { status: 'retryable', errorCode: 'rate_limited' }
  }
  return {
    status: ['internal_error', 'fatal_error', 'service_unavailable'].includes(
      error
    )
      ? uncertain(preparing)
      : 'rejected',
    errorCode: 'slack_api_error'
  }
}

function uncertain(preparing: boolean): 'retryable' | 'unknown' {
  return preparing ? 'retryable' : 'unknown'
}

export function sdkFailure(error: unknown, preparing = false): SendResult {
  if (error instanceof WebAPIPlatformError) {
    return apiError(error.data.error, preparing)
  }
  if (error instanceof WebAPIRateLimitedError) {
    return {
      status: 'retryable',
      errorCode: 'rate_limited',
      retryAfterMs: Math.ceil(error.retryAfter * 1000)
    }
  }
  if (error instanceof WebAPIHTTPError) {
    return {
      status: error.statusCode < 500 ? 'rejected' : uncertain(preparing),
      errorCode: 'platform_http_error'
    }
  }
  return {
    status: preparing ? 'retryable' : 'unknown',
    errorCode: 'slack_transport_error'
  }
}

export function sendOutcome(response: ChatPostMessageResponse): SendResult {
  return response.ok && response.ts
    ? { status: 'sent', receipt: { platformMessageId: response.ts } }
    : { status: 'unknown', errorCode: 'invalid_platform_response' }
}

export async function discoverIdentity(
  client: WebClient
): Promise<{ botUserId: string; teamId: string }> {
  const identity = await client.auth.test()
  if (!identity.user_id || !identity.team_id || !identity.bot_id) {
    throw new Error('slack_identity_unavailable')
  }
  return { botUserId: identity.user_id, teamId: identity.team_id }
}
