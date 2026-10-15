import { HTTPFetchError, messagingApi } from '@line/bot-sdk'
import type { SendResult } from '@relanox/sdk'
import type { LineConfig } from './config.js'
import { secret, failure, unavailable } from './io.js'

export { validateSignature } from '@line/bot-sdk'

export function lineClient(
  config: LineConfig
): messagingApi.MessagingApiClient {
  return new messagingApi.MessagingApiClient({
    channelAccessToken: secret(config.accessToken)
  })
}

export function sdkFailure(error: unknown): SendResult {
  if (!(error instanceof HTTPFetchError)) {
    return unavailable()
  }
  const accepted = error.headers.get('x-line-accepted-request-id')
  if (error.status === 409 && accepted) {
    return {
      status: 'sent',
      receipt: { data: { acceptedRequestId: accepted } }
    }
  }
  return failure(
    new Response(null, { status: error.status, headers: error.headers })
  )
}
