import { z } from 'zod'
import { API_BASE_URL, REQUEST_TIMEOUT_MS, platformIdSchema } from './config.js'
import type { DiscordConfig } from './config.js'
import { channelInfoSchema } from './schemas.js'
import type { messageSchema } from './schemas.js'
import { credential, jsonResponse } from './transport.js'

type MessageTarget = { chatId: string; threadId?: string }

const lifecycleSchema = z.object({ id: platformIdSchema })

/** Channel metadata belongs to one account connection; reconnects discard it. */
export function createMessageTargets(
  config: DiscordConfig,
  environment: NodeJS.ProcessEnv
): {
  resolve(
    message: z.infer<typeof messageSchema>,
    signal: AbortSignal
  ): Promise<MessageTarget>
  invalidate(value: unknown): void
  clear(): void
} {
  const cache = new Map<string, { target: MessageTarget; expiresAt: number }>()

  return {
    async resolve(message, signal) {
      if (!message.guild_id) {
        return { chatId: message.channel_id }
      }
      const cached = cache.get(message.channel_id)
      if (cached && cached.expiresAt > Date.now()) {
        return cached.target
      }
      cache.delete(message.channel_id)

      const response = await fetch(
        `${API_BASE_URL.replace(/\/$/u, '')}/channels/${encodeURIComponent(message.channel_id)}`,
        {
          headers: {
            authorization: `Bot ${credential(config.botToken, environment)}`
          },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          ]),
          redirect: 'error'
        }
      )

      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('channel_lookup_failed')
      }
      const channel = channelInfoSchema.parse(await jsonResponse(response))
      if (channel.id !== message.channel_id) {
        throw new Error('channel_lookup_mismatch')
      }
      const thread = [10, 11, 12].includes(channel.type)
      if (thread && !channel.parent_id) {
        throw new Error('thread_parent_missing')
      }

      const target: MessageTarget = thread
        ? { chatId: channel.parent_id as string, threadId: message.channel_id }
        : { chatId: message.channel_id }

      cache.set(message.channel_id, { target, expiresAt: Date.now() + 60_000 })
      if (cache.size > 256) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) {
          cache.delete(oldest)
        }
      }
      return target
    },
    invalidate(value) {
      const channel = lifecycleSchema.safeParse(value)
      if (channel.success) {
        cache.delete(channel.data.id)
      }
    },
    clear() {
      cache.clear()
    }
  }
}
