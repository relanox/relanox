import { afterEach, vi } from 'vitest'
import { noopObservability } from '@relanox/sdk'
import type {
  ChannelHost,
  ChannelPlugin,
  HttpHandler,
  IngestInput,
  Json,
  ReplyTarget,
  SendInput
} from '@relanox/sdk'
import { createSqliteStorage } from '../../storage-sqlite/src/index.js'
import { mediaPeer } from './media-peer.js'
import {
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { primaryFactories } from './resolution-primary.js'
import { secondaryFactories } from './resolution-secondary.js'

const factories = { ...primaryFactories, ...secondaryFactories }

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

function platformConfig(
  platform: string,
  origin: string
): Record<string, Json> {
  const credential = { env: 'CREDENTIAL' }

  const configs: Record<string, Record<string, Json>> = {
    telegram: {
      botToken: { env: 'TELEGRAM_TOKEN' },
      webhookSecret: credential,
      apiBaseUrl: origin
    },
    discord: { botToken: credential },
    slack: { botToken: credential, appId: 'app', signingSecret: credential },
    matrix: { homeserver: origin, accessToken: credential },
    mattermost: { serverUrl: origin, token: credential },
    googlechat: { serviceAccount: { env: 'GOOGLE_SERVICE' } },
    line: { accessToken: credential, channelSecret: credential },
    signal: { serviceUrl: origin, account: '+15550001' },
    irc: { server: 'irc.example', nick: 'relay' },
    feishu: {
      appId: 'app',
      appSecret: credential,
      verificationToken: credential,
      encryptKey: credential,
      tenantKey: 'tenant'
    },
    dingtalk: {
      clientId: 'app',
      clientSecret: credential,
      robotCode: 'robot',
      recipientTypes: { user: 'single', group: 'group' }
    },
    qq: {
      appId: 'app',
      clientSecret: credential,
      recipientTypes: { user: 'c2c', group: 'group' }
    },
    wecom: {
      botId: 'bot',
      secret: credential,
      recipientTypes: { user: 'single', group: 'group' }
    },
    whatsapp: {
      phoneNumberId: 'phone',
      businessAccountId: 'business',
      appSecret: credential,
      verifyToken: credential,
      accessToken: credential
    },
    msteams: {
      appId: 'app',
      botId: 'bot',
      tenantId: 'tenant',
      appSecret: credential,
      trustedServiceOrigins: [origin]
    }
  }

  const config = configs[platform]
  if (!config) {
    throw new Error('unknown_platform')
  }
  return config
}

function platformResponse(path: string): { status?: number; json: unknown } {
  const responses: Record<string, unknown> = {
    '/users/@me': { id: '123', bot: true },
    '/gateway/bot': { url: 'wss://gateway.discord.gg' },
    '/auth.test': { ok: true, bot_id: 'B1', user_id: 'UBOT', team_id: 'T1' },
    '/_matrix/client/v3/account/whoami': { user_id: '@bot:example' },
    '/api/v4/users/me': { id: 'bot' },
    '/v2/bot/info': { userId: 'Ubot' },
    '/open-apis/auth/v3/tenant_access_token/internal': {
      code: 0,
      tenant_access_token: 'token',
      expire: 7200
    },
    '/open-apis/bot/v3/info': { code: 0, bot: { open_id: 'bot' } },
    '/v1.0/oauth2/accessToken': { accessToken: 'token', expireIn: 7200 },
    '/app/getAppAccessToken': { access_token: 'token', expires_in: 7200 },
    '/token': { access_token: 'token' }
  }

  if (path.endsWith('/state/m.room.encryption')) {
    // Matrix Client-Server v1.16 GET /rooms/{roomId}/state/{eventType}/{stateKey}:
    // https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey
    // Matrix-js-sdk d633e7c1954a6b92597fbc3f8a95f183789a8d40 src/client.ts getStateEvent caller.
    // A missing state event returns 404 with the native M_NOT_FOUND error code.
    return { status: 404, json: { errcode: 'M_NOT_FOUND' } }
  }
  if (path === '/api/v1/rpc') {
    return {
      json: { jsonrpc: '2.0', id: 'delivery:0', result: { timestamp: 1 } }
    }
  }
  if (path in responses) {
    return { json: responses[path] }
  }
  return {
    json: {
      ok: true,
      result: { message_id: 42, timestamp: 1 },
      id: 'sent',
      ts: '1700000000.003',
      event_id: '$sent',
      name: 'spaces/one/messages/sent',
      messaging_product: 'whatsapp',
      messages: [{ id: 'sent' }],
      code: 0,
      data: { message_id: 'sent' },
      processQueryKey: 'sent',
      jsonrpc: '2.0'
    }
  }
}

export async function resolutionFixture(
  platform: string,
  overrides: Record<string, Json> = {}
): Promise<{
  plugin: ChannelPlugin<unknown>
  remote: Awaited<ReturnType<typeof mediaPeer>>
  host: ChannelHost
  origin: string
  handlers: Map<string, HttpHandler>
  received: IngestInput[]
}> {
  vi.stubEnv('CREDENTIAL', 'secret')
  vi.stubEnv('TELEGRAM_TOKEN', '123:secret')
  vi.stubEnv(
    'GOOGLE_SERVICE',
    JSON.stringify({
      type: 'service_account',
      client_email: 'bot@example.com',
      private_key: 'key'
    })
  )
  const remote = await mediaPeer((request) => platformResponse(request.path))
  cleanup.push(remote.close)
  const origin = registerPeer(remote.origin)
  for (const platformOrigin of [
    'https://discord.com',
    'https://slack.com',
    'https://api.line.me',
    'https://open.feishu.cn',
    'https://api.dingtalk.com',
    'https://bots.qq.com',
    'https://api.sgroup.qq.com',
    'https://oauth2.googleapis.com',
    'https://chat.googleapis.com',
    'https://graph.facebook.com'
  ]) {
    routePlatform(platformOrigin, origin)
  }
  const factory = factories[platform]
  if (!factory) {
    throw new Error('unknown_platform')
  }
  const plugin = factory()
  const storage = createSqliteStorage({ filename: ':memory:' })
  await storage.initialize()
  cleanup.push(async () => storage.close())
  const namespace = { pluginId: plugin.id, ownerId: 'account' }
  const handlers = new Map<string, HttpHandler>()
  const received: IngestInput[] = []

  const host: ChannelHost = {
    observe: noopObservability,
    publicUrl: 'https://relay.example',
    boundChatIds: [],
    state: {
      get: async (key) => storage.getState(namespace, key),
      list: async (input) => storage.listState(namespace, input),
      compareAndSet: async (input) =>
        storage.compareAndSetState(namespace, input),
      delete: async (key, version) =>
        storage.deleteState(namespace, key, version)
    },
    mountHttp: (path, handler) => {
      handlers.set(path, handler)
    },
    connection: () => {},
    ingest: async (input) => {
      received.push(input)
      return { requestId: 'request', duplicate: false }
    }
  }

  const raw = platformConfig(platform, origin)
  await plugin.setup(
    host,
    {
      id: 'account',
      channel: plugin.channel,
      config: null,
      allowedSenders: ['15550002']
    },
    plugin.validateConfig({ ...raw, ...overrides })
  )
  return { plugin, remote, host, origin, handlers, received }
}

export function resolverInput(target: ReplyTarget): SendInput {
  return {
    channelId: 'channel',
    deliveryId: 'delivery',
    target,
    chunkIndex: 0,
    chunk: { text: 'hello', idempotencyKey: 'delivery:0', state: null },
    signal: new AbortController().signal
  }
}
