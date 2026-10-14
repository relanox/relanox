import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AgentHost,
  AgentPlugin,
  ChannelHost,
  ChannelPlugin,
  DispatchInput,
  RelanoxConfig,
  SpeechToTextProvider
} from '../../packages/sdk/src/index.js'
import { createCore } from '../../packages/core/src/index.js'
import { createSqliteStorage } from '../../plugins/storage-sqlite/src/index.js'
import { required } from '../contracts/storage-contract.js'
import type { CoreRuntime } from '../../packages/core/src/types.js'

type Fixture = {
  readonly runtime: CoreRuntime
  readonly dispatched: DispatchInput['request'][]
  readonly channel: ChannelHost
  readonly storage: ReturnType<typeof createSqliteStorage>
  principal(): ReturnType<AgentHost['forPrincipal']>
  setRetryDispatch(value: boolean): void
  restart(next?: SpeechToTextProvider | null): Promise<CoreRuntime>
  close(): Promise<void>
}

/** Capture plugin boundaries while routing, media ownership, persistence and recovery stay real. */
export async function speechFixture(
  provider?: SpeechToTextProvider,
  agentId: 'dot' | 'grok' = 'dot'
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-speech-'))
  const filename = join(directory, 'relay.sqlite')
  let storage = createSqliteStorage({ filename })
  let channelHost: ChannelHost | undefined
  let agentHost: AgentHost | undefined
  const dispatched: DispatchInput['request'][] = []
  let retryDispatch = false

  const channel: ChannelPlugin = {
    id: 'channel-telegram',
    kind: 'channel',
    channel: 'telegram',
    sdkMajor: 1,
    runtime: 'node',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 4096,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      media: { receive: ['audio', 'image', 'video'], send: [] }
    },
    validateConfig: () => null,
    async setup(host) {
      channelHost = host
    },
    async send() {
      return { status: 'sent', receipt: {} }
    }
  }

  const agent: AgentPlugin = {
    id: `agent-${agentId}`,
    kind: 'agent',
    agent: agentId,
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: () => null,
    async setup(host) {
      agentHost = host
    },
    async dispatch({ request }) {
      dispatched.push(request)
      return retryDispatch
        ? { status: 'retryable', errorCode: 'unavailable' }
        : { status: 'accepted' }
    }
  }

  const config: RelanoxConfig = {
    accounts: [
      {
        id: 'bot',
        channel: 'telegram',
        config: null,
        allowedSenders: ['alice']
      }
    ],
    endpoints: [{ id: 'first', agent: agentId, config: null }],
    bindings: [{ accountId: 'bot', chatId: 'chat', endpointId: 'first' }],
    storage: { plugin: 'sqlite', config: {} },
    observability: { plugin: 'none', config: {} }
  }

  const assemble = async (
    speechToText: SpeechToTextProvider | undefined
  ): Promise<CoreRuntime> => {
    await storage.initialize()
    return createCore({
      config,
      storage,
      publicUrl: 'https://relay.example',
      channels: new Map([['bot', channel]]),
      agents: new Map([[agentId, agent]]),
      ...(speechToText ? { speechToText } : {})
    })
  }

  const close = async (): Promise<void> => {
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }

  try {
    const runtime = await assemble(provider)
    return {
      runtime,
      dispatched,
      get channel() {
        return required(channelHost)
      },
      get storage() {
        return storage
      },
      principal: () =>
        required(agentHost).forPrincipal({
          subject: 'test',
          endpointIds: ['first']
        }),
      setRetryDispatch(value: boolean) {
        retryDispatch = value
      },
      async restart(next: SpeechToTextProvider | null = provider ?? null) {
        await storage.close()
        storage = createSqliteStorage({ filename })
        return assemble(next ?? undefined)
      },
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
