import { listenPeer } from '../../../tests/listen.js'
import { vi } from 'vitest'
import { createCore } from '../../../packages/core/src/index.js'
import type { WorkerOptions } from '../../../packages/core/src/index.js'
import { noopObservability } from '@relanox/sdk'
import { createSqliteStorage } from '../../storage-sqlite/src/index.js'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import {
  createListeners,
  closeServer
} from '../../../apps/cli/src/listeners.js'
import { createSlackChannel } from '../src/index.js'

export async function fixture(
  filename: string,
  cleanup: (() => Promise<void>)[],
  socket = false,
  worker: WorkerOptions = {},
  chatIds: readonly string[] = ['C7']
): Promise<{
  core: Awaited<ReturnType<typeof createCore>>
  storage: ReturnType<typeof createSqliteStorage>
  origin: string
  plugin: ReturnType<typeof createSlackChannel>
}> {
  vi.stubEnv('SLACK_TEST_MCP', 'mcp-token')
  vi.stubEnv('SLACK_TEST_ROUTINE', 'https://routine.example/invoke')
  vi.stubEnv('SLACK_TEST_AUTH', 'Bearer routine-token')

  const plugin = createSlackChannel({
    BOT: 'xoxb-token',
    SIGN: 'signing-secret',
    APP: 'xapp-token'
  })

  const agent = createGrokAgentPlugin()
  const storage = createSqliteStorage({ filename })
  await storage.initialize()
  cleanup.push(
    async () => storage.close(),
    async () => agent.stop?.(),
    async () => plugin.stop?.()
  )

  const core = await createCore({
    publicUrl: 'https://relay.example',
    worker,
    storage,
    channels: new Map([['sl', plugin]]),
    agents: new Map([['grok', agent]]),
    config: {
      accounts: [
        {
          id: 'sl',
          channel: 'slack',
          allowedSenders: ['U42'],
          config: {
            botToken: { env: 'BOT' },
            ...(socket
              ? { appToken: { env: 'APP' } }
              : { signingSecret: { env: 'SIGN' } }),
            appId: 'A1'
          }
        }
      ],
      endpoints: [
        {
          id: 'agent',
          agent: 'grok',
          config: {
            mcp: { token: { env: 'SLACK_TEST_MCP' } },
            routineUrl: { env: 'SLACK_TEST_ROUTINE' },
            routineAuthorization: { env: 'SLACK_TEST_AUTH' }
          }
        }
      ],
      bindings: chatIds.map((chatId) => ({
        accountId: 'sl',
        chatId,
        endpointId: 'agent'
      })),
      storage: { plugin: 'sqlite', config: { filename } },
      observability: { plugin: 'none', config: {} }
    }
  })

  const servers = createListeners(
    core,
    {
      observe: noopObservability,
      flush: async () => {},
      shutdown: async () => {}
    },
    () => true,
    () => true
  )

  const origin = await listenPeer(servers.business)
  cleanup.push(async () => closeServer(servers.business))
  return { core, storage, origin, plugin }
}
