import { createCore } from '../../../packages/core/src/index.js'
import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { createSqliteStorage } from '../../storage-sqlite/src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHost, AgentPlugin, AccountConfig } from '@relanox/sdk'
import { createFeishuChannel } from '../src/index.js'

export async function storedChannel(
  cleanup: (() => Promise<void>)[],
  environment: NodeJS.ProcessEnv,
  account: AccountConfig
): Promise<{
  core: CoreRuntime
  storage: ReturnType<typeof createSqliteStorage>
  agentHost: AgentHost
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-feishu-policy-'))

  const storage = createSqliteStorage({
    filename: join(directory, 'relay.sqlite')
  })

  cleanup.push(async () => {
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })
  await storage.initialize()
  let agentHost: AgentHost | undefined

  const agent: AgentPlugin = {
    id: 'agent-grok',
    kind: 'agent',
    agent: 'grok',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: () => null,
    async setup(host) {
      agentHost = host
    },
    async dispatch() {
      return { status: 'accepted' }
    }
  }

  const core = await createCore({
    publicUrl: 'https://relay.example',
    storage,
    channels: new Map([['fs', createFeishuChannel(environment)]]),
    agents: new Map([['grok', agent]]),
    config: {
      accounts: [
        {
          ...account,
          config: {
            appId: 'cli_app',
            appSecret: { env: 'APPSECRET' },
            encryptKey: { env: 'ENCRYPT' },
            verificationToken: { env: 'VERIFY' },
            tenantKey: 'tenant-1'
          }
        }
      ],
      endpoints: [{ id: 'first', agent: 'grok', config: null }],
      bindings: [
        {
          accountId: 'fs',
          chatId: 'oc_chat',
          threadId: 'omt_thread',
          endpointId: 'first'
        }
      ],
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  if (!agentHost) {
    throw new Error('missing_agent_host')
  }
  return { core, storage, agentHost }
}
