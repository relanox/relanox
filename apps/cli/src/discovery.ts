import { readFile } from 'node:fs/promises'
import { createWeComChannel } from '@relanox/channel-wecom'
import { noopObservability } from '@relanox/sdk'
import type { AccountConfig, ChannelHost } from '@relanox/sdk'
import { z } from 'zod'

const accountSchema = z.object({
  id: z.string().min(1),
  channel: z.literal('wecom'),
  config: z.json(),
  allowedSenders: z.array(z.string().min(1)).default([])
})

/** Read only the selected channel boundary; unfinished agent/binding setup is intentional. */
export async function readDiscoveryAccount(
  path: string,
  accountId: string
): Promise<AccountConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))

  const draft = z
    .object({ relay: z.object({ accounts: z.array(z.unknown()) }) })
    .parse(raw)

  const matches = draft.relay.accounts.filter(
    (account) =>
      z.object({ id: z.literal(accountId) }).safeParse(account).success
  )

  if (matches.length !== 1) {
    throw new Error('discovery_account_missing_or_duplicate')
  }
  return accountSchema.parse(matches[0])
}

export type DiscoveryOutput = {
  readonly ok: boolean
  readonly event:
    | 'discovery_started'
    | 'discovery_connected'
    | 'conversation'
    | 'discovery_stopped'
  readonly accountId: string
  readonly channel: 'wecom'
  readonly chatId?: string
  readonly senderId?: string
  readonly threadId?: string
  readonly reason?: 'timeout' | 'signal'
}

function unavailable(): never {
  throw new Error('discovery_resource_unavailable')
}

/** No relay, persistence, content, media, or Agent resources exist in this session. */
export async function discoverConversations(input: {
  readonly configPath: string
  readonly accountId: string
  readonly timeoutSeconds: number
  readonly signal: AbortSignal
  output(value: DiscoveryOutput): void
}): Promise<void> {
  const account = await readDiscoveryAccount(input.configPath, input.accountId)
  const plugin = createWeComChannel()
  const config = plugin.validateConfig(account.config)
  if (!process.env[config.secret.env]) {
    throw new Error('missing_discovery_secret')
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, input.signal])
  const scope = { accountId: account.id, channel: 'wecom' as const }
  const seen = new Set<string>()

  const host: ChannelHost = {
    observe: noopObservability,
    state: {
      get: unavailable,
      list: unavailable,
      compareAndSet: unavailable,
      delete: unavailable
    },
    mountHttp: unavailable,
    ingest: unavailable,
    connection(status) {
      if (status === 'connected' && !signal.aborted) {
        input.output({ ok: true, event: 'discovery_connected', ...scope })
      }
    },
    discoverConversation(address) {
      if (signal.aborted) {
        return
      }

      const key = JSON.stringify([
        address.chatId,
        address.senderId,
        address.threadId
      ])

      if (seen.has(key)) {
        return
      }
      seen.add(key)
      input.output({
        ok: true,
        event: 'conversation',
        ...scope,
        chatId: address.chatId,
        senderId: address.senderId,
        ...(address.threadId === undefined
          ? {}
          : { threadId: address.threadId })
      })
    }
  }

  const timer = setTimeout(() => {
    controller.abort()
  }, input.timeoutSeconds * 1000)

  try {
    signal.throwIfAborted()
    await plugin.setup(host, account, config)
    input.output({ ok: true, event: 'discovery_started', ...scope })
    await plugin.start?.(signal)
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true }
      )
      if (signal.aborted) {
        resolve()
      }
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
    await plugin.stop?.()
  }
  input.output({
    ok: true,
    event: 'discovery_stopped',
    ...scope,
    reason: input.signal.aborted ? 'signal' : 'timeout'
  })
}
