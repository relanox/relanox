import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import type { ChannelId, Json, ScopedAgentHost } from '@relanox/sdk'
import { vi } from 'vitest'
import { startRuntime, validateApp } from '../../../apps/cli/src/runtime.js'
import { availablePort } from '../../../tests/e2e/peer.js'
import { mediaPeer } from './media-peer.js'
import { redirectRoutine } from '../../agent-grok/tests/routine-peer.js'

export type MediaRuntime = Awaited<ReturnType<typeof startRuntime>>
export type Cleanup = () => Promise<void>

export async function mediaRuntime(
  cleanups: Cleanup[],
  channel: ChannelId,
  config: Json,
  chatId: string,
  threadId?: string
): Promise<{
  start(this: void): Promise<MediaRuntime>
  client(this: void, runtime: MediaRuntime): Promise<Client>
  routine: Awaited<ReturnType<typeof mediaPeer>>
  principal(this: void): ScopedAgentHost
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-native-media-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  const routine = await mediaPeer(() => ({ json: {} }))
  cleanups.push(routine.close)
  redirectRoutine(routine.origin)
  const port = await availablePort()
  vi.stubEnv('MEDIA_AGENT_TOKEN', 'media-agent-token')
  vi.stubEnv('MEDIA_ROUTINE_URL', 'https://routine.test/routine')
  vi.stubEnv('MEDIA_ROUTINE_AUTH', 'Bearer media-routine-token')

  const app = await validateApp({
    publicUrl: `http://127.0.0.1:${port}`,
    relay: {
      accounts: [{ id: 'business', channel, config, allowedSenders: ['42'] }],
      endpoints: [
        {
          id: 'media',
          agent: 'grok',
          config: {
            mcp: {
              token: { env: 'MEDIA_AGENT_TOKEN' }
            },
            routineUrl: { env: 'MEDIA_ROUTINE_URL' },
            routineAuthorization: { env: 'MEDIA_ROUTINE_AUTH' }
          }
        }
      ],
      bindings: [
        {
          accountId: 'business',
          chatId,
          ...(threadId ? { threadId } : {}),
          endpointId: 'media'
        }
      ],
      storage: {
        plugin: 'sqlite',
        config: { filename: join(directory, 'relay.sqlite') }
      },
      observability: { plugin: 'none', config: {} }
    },
    server: {
      port,
      managementPort: 0,
      shutdownTimeoutMs: 5000
    }
  })

  let principal: ScopedAgentHost | undefined
  const catalog = await import('../../../apps/cli/src/plugins.js')
  const loadPlugins = catalog.loadPlugins

  const capture = vi
    .spyOn(catalog, 'loadPlugins')
    .mockImplementation(async (relayConfig, loader) => {
      const plugins = await loadPlugins(relayConfig, loader)
      const agent = plugins.agents.get('grok')
      if (agent) {
        const setup = agent.setup.bind(agent)
        agent.setup = async (host, endpoints, pluginConfig): Promise<void> => {
          principal = host.forPrincipal({
            subject: 'media',
            endpointIds: ['media']
          })
          await setup(host, endpoints, pluginConfig)
        }
      }
      return plugins
    })

  cleanups.push(async () => {
    capture.mockRestore()
  })

  const start = async (): Promise<MediaRuntime> => {
    const runtime = await startRuntime(app)
    cleanups.push(runtime.stop)
    return runtime
  }

  const client = async (runtime: MediaRuntime): Promise<Client> => {
    const connected = new Client(
      { name: 'native-media-wire', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    )

    cleanups.push(async () => connected.close())
    await connected.connect(
      new StreamableHTTPClientTransport(
        new URL(`${runtime.businessUrl}/agents/grok/mcp/media`),
        {
          requestInit: {
            headers: {
              authorization: 'Bearer media-agent-token',
              connection: 'close'
            }
          }
        }
      )
    )
    return connected
  }

  return {
    start,
    client,
    routine,
    principal: () => {
      if (!principal) {
        throw new Error('missing_media_principal')
      }
      return principal
    }
  }
}
