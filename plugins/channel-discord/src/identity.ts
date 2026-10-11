import { z } from 'zod'
import {
  API_BASE_URL,
  REQUEST_TIMEOUT_MS,
  validateTransportUrl
} from './config.js'
import { jsonResponse } from './transport.js'

export type DiscordIdentity = { botId: string; gatewayUrl: string }

export async function discoverIdentity(
  token: string
): Promise<DiscordIdentity> {
  const headers = { authorization: `Bot ${token}` }

  const responses = await Promise.all(
    ['/users/@me', '/gateway/bot'].map(async (path) => {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('discord_identity_unavailable')
      }
      return jsonResponse(response)
    })
  )

  const user = z
    .object({ id: z.string().regex(/^\d+$/u), bot: z.literal(true) })
    .parse(responses[0])

  const gateway = z.object({ url: z.string() }).parse(responses[1])
  return {
    botId: user.id,
    gatewayUrl: validateTransportUrl(gateway.url, false, true)
  }
}
