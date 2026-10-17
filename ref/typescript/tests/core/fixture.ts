import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentHost,
  AgentPlugin,
  ChannelHost,
  ChannelPlugin,
  MediaKind,
  RelanoxConfig,
  SendInput
} from '../../packages/sdk/src/index.js'
import type { CoreOptions, CoreRuntime } from '../../packages/core/src/types.js'
import { createCore } from '../../packages/core/src/index.js'
import { createSqliteStorage } from '../../plugins/storage-sqlite/src/index.js'

export async function mediaFixture(
  sendKinds: readonly MediaKind[] = ['image', 'file'],
  publicUrl = 'https://relay.example',
  media?: CoreOptions['media'],
  richText?: ChannelPlugin['capabilities']['richText']
): Promise<{
  channelId: string
  storage: ReturnType<typeof createSqliteStorage>
  filename: ReturnType<typeof join>
  close(this: void): Promise<void>
  runtime: CoreRuntime
  channel: ChannelHost
  agent: AgentHost
  sent: SendInput[]
  restart(this: void, next?: RelanoxConfig): Promise<CoreRuntime>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-core-media-'))
  const filename = join(directory, 'relay.sqlite')
  let storage = createSqliteStorage({ filename })

  const close = async (): Promise<void> => {
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  }

  await storage.initialize()
  let channelHost: ChannelHost | undefined
  let agentHost: AgentHost | undefined
  const sent: SendInput[] = []

  const channel: ChannelPlugin = {
    id: 'channel-telegram',
    kind: 'channel',
    channel: 'telegram',
    sdkMajor: 1,
    runtime: 'node',
    capabilities: {
      receive: true,
      transport: 'http',
      maxTextLength: 3,
      lengthUnit: 'codepoint',
      idempotentSend: false,
      ...(richText ? { richText } : {}),
      media: { receive: ['image', 'file'], send: sendKinds }
    },
    validateConfig: () => null,
    async resolveChannel(address) {
      return {
        status: 'available',
        target: {
          channel: address.platform,
          accountId: address.accountId,
          chatId: address.chatId,
          ...(address.threadId === undefined
            ? {}
            : { threadId: address.threadId }),
          data: null
        }
      }
    },
    async setup(host) {
      channelHost = host
    },
    async send(input) {
      sent.push(input)
      return {
        status: 'sent',
        receipt: { platformMessageId: String(sent.length) }
      }
    }
  }

  const agent: AgentPlugin = {
    id: 'agent-grok',
    kind: 'agent',
    agent: 'grok',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: () => null,
    async setup(host) {
      agentHost = host
      host.mountHttp(
        '/json',
        async (request) => new Response(await request.arrayBuffer())
      )
      host.mountHttp(
        '/media/*',
        async (request) => new Response(await request.arrayBuffer()),
        {
          maxBodyBytes: 16,
          authorize: async (request) =>
            request.headers.get('authorization') === 'Bearer test'
              ? undefined
              : new Response(null, { status: 401 })
        }
      )
    },
    async dispatch() {
      return { status: 'accepted' }
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
    endpoints: [
      { id: 'first', agent: 'grok', config: null },
      { id: 'other', agent: 'grok', config: null }
    ],
    bindings: [{ accountId: 'bot', chatId: 'chat', endpointId: 'first' }],
    storage: { plugin: 'sqlite', config: {} },
    observability: { plugin: 'none', config: {} }
  }

  try {
    const assemble = async (relay = config): Promise<CoreRuntime> =>
      createCore({
        publicUrl,
        ...(media ? { media } : {}),
        config: relay,
        storage,
        channels: new Map([['bot', channel]]),
        agents: new Map([['grok', agent]]),
        worker: {
          maxMediaBytes: 16,
          maxTotalMediaBytes: 24,
          maxAttachments: 2
        }
      })

    const runtime = await assemble()
    if (!channelHost || !agentHost) {
      throw new Error('Hosts not initialized')
    }

    const channelId = (
      await agentHost
        .forPrincipal({ subject: 'fixture', endpointIds: ['first'] })
        .status()
    ).channels[0]?.channel.id

    if (!channelId) {
      throw new Error('Missing configured channel')
    }
    return {
      channelId,
      get storage() {
        return storage
      },
      filename,
      close,
      runtime,
      get channel() {
        return requireHost<ChannelHost>(channelHost)
      },
      get agent() {
        return requireHost<AgentHost>(agentHost)
      },
      sent,
      async restart(next?: RelanoxConfig): Promise<CoreRuntime> {
        await storage.close()
        storage = createSqliteStorage({ filename })
        await storage.initialize()
        return assemble(next)
      }
    }
  } catch (error) {
    await close()
    throw error
  }
}

export const incoming = {
  source: {
    channel: 'telegram' as const,
    accountId: 'bot',
    eventId: 'media-event'
  },
  senderId: 'alice',
  text: '',
  target: {
    channel: 'telegram' as const,
    accountId: 'bot',
    chatId: 'chat',
    data: null
  },
  context: null,
  receivedAt: 1
}

export const picture = {
  kind: 'image' as const,
  mimeType: 'image/png',
  fileName: 'picture.png',
  data: new Uint8Array([1, 2, 3])
}

function requireHost<T>(host: T | undefined): T {
  if (host === undefined) {
    throw new Error('Host missing')
  }
  return host
}
