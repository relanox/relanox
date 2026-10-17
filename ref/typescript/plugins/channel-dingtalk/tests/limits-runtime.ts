import { createCore } from '@relanox/core'
import type { WorkerOptions } from '@relanox/core'
import type { AgentPlugin, ChannelPlugin, Storage } from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { createDingTalkChannel } from '../src/index.js'

export async function limitsRuntime(worker: WorkerOptions): Promise<{
  storage: Storage
  start(this: void): Promise<void | undefined>
  close(this: void): Promise<void>
}> {
  const storage = createSqliteStorage({ filename: ':memory:' })
  const channel = createDingTalkChannel()
  const controller = new AbortController()

  const agent: AgentPlugin<unknown> = {
    id: 'grok',
    kind: 'agent',
    agent: 'grok',
    runtime: 'node',
    sdkMajor: 1,
    validateConfig: (value) => value,
    async setup() {},
    async dispatch() {
      return { status: 'accepted' }
    }
  }

  try {
    await storage.initialize()
    await createCore({
      publicUrl: 'https://relay.example',
      config: {
        accounts: [
          {
            id: 'bot',
            channel: 'dingtalk',
            allowedSenders: ['sender'],
            config: {
              clientId: 'app',
              robotCode: 'robot',
              clientSecret: { env: 'DING_LIMIT_SECRET' }
            }
          }
        ],
        endpoints: [{ id: 'agent', agent: 'grok', config: {} }],
        bindings: [{ accountId: 'bot', chatId: 'staff', endpointId: 'agent' }],
        storage: { plugin: 'sqlite', config: { filename: ':memory:' } },
        observability: { plugin: 'none', config: {} }
      },
      storage,
      worker,
      channels: new Map([['bot', channel as ChannelPlugin<unknown>]]),
      agents: new Map([['grok', agent]])
    })
  } catch (error) {
    await storage.close()
    throw error
  }
  return {
    storage,
    start: async () => channel.start?.(controller.signal),
    async close() {
      controller.abort()
      await channel.stop?.()
      await storage.close()
    }
  }
}
