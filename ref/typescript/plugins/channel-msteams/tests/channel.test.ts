import type {
  CoreRuntime,
  CoreOptions
} from '../../../packages/core/src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Json,
  SendInput,
  Storage,
  ScopedAgentHost,
  InboundSnapshot,
  OutboundRecord
} from '@relanox/sdk'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTeamsChannel } from '../src/index.js'
import { harness, peer, oauthToken } from './harness.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
const issuer = 'https://api.botframework.com'

const tokenPath = '/botframework.com/oauth2/v2.0/token'

async function sendInput(
  local: Awaited<ReturnType<typeof setup>>
): Promise<SendInput> {
  expect((await local.core.fetch(await local.incoming())).status).toBe(200)
  const record = (await local.storage.listInbound({ limit: 1 }))[0]
  if (!record) {
    throw new Error('missing_incoming_activity')
  }
  return {
    deliveryId: 'oauth-test',
    channelId: record.snapshot.channel.id,
    chunkIndex: 0,
    target: record.snapshot.target,
    chunk: { text: 'answer', idempotencyKey: 'oauth-test:0', state: null },
    signal: new AbortController().signal
  }
}

// Protect token reuse across real sends and expiry/rotation. Single-send coverage
// Cannot detect redundant exchanges; the existing plugin API is the only seam.
// https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
it('uses SDK cached Teams tokens and refreshes after expiry and secret rotation', async () => {
  const local = await setup()
  const input = await sendInput(local)

  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })

  const results = await Promise.all(
    Array.from({ length: 4 }, async () => local.plugin.send(input))
  )

  expect(results.map((result) => result.status)).toEqual([
    'sent',
    'sent',
    'sent',
    'sent'
  ])
  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(
    local.remote.traffic.filter((entry) => entry.path === tokenPath)
  ).toHaveLength(1)

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 3_600_000)
  const refreshedToken = oauthToken('refreshed-token')
  local.remote.token(200, {
    access_token: refreshedToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(local.remote.traffic.at(-1)?.headers.authorization).toBe(
    `Bearer ${refreshedToken}`
  )
  expect(
    local.remote.traffic.filter((entry) => entry.path === tokenPath)
  ).toHaveLength(2)

  vi.stubEnv('TEAMS_SECRET', 'rotated-secret')
  const rotatedToken = oauthToken('rotated-token')
  local.remote.token(200, {
    access_token: rotatedToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(local.remote.traffic.at(-1)?.headers.authorization).toBe(
    `Bearer ${rotatedToken}`
  )

  const tokens = local.remote.traffic.filter(
    (entry) => entry.path === tokenPath
  )

  expect(tokens).toHaveLength(3)
  expect(
    Object.fromEntries(new URLSearchParams(tokens.at(-1)?.body))
  ).toMatchObject({
    grant_type: 'client_credentials',
    client_id: 'app-id',
    client_secret: 'rotated-secret',
    scope: 'https://api.botframework.com/.default'
  })
  expect(tokens.at(-1)?.headers.authorization).toBeUndefined()
})

// A cached credential rejected by the service must be replaceable without replaying
// A message inside the adapter. Existing status tests start without a cached token.
// https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
it('reacquires rejected Teams OAuth credentials on the next send without internal message replay', async () => {
  const local = await setup()
  const input = await sendInput(local)
  const first = await local.plugin.send(input)
  expect(first).toMatchObject({ status: 'sent' })
  local.remote.respond(401, { error: { code: 'Unauthorized' } })
  expect(await local.plugin.send(input)).toEqual({
    status: 'retryable',
    errorCode: 'oauth_token_rejected'
  })
  expect(
    local.remote.traffic.filter((entry) => entry.path.startsWith('/teams/v3'))
  ).toHaveLength(2)
  const replacementToken = oauthToken('replacement-token')
  local.remote.token(200, {
    access_token: replacementToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  local.remote.respond(200, { id: 'recovered' })
  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(local.remote.traffic.at(-1)?.headers.authorization).toBe(
    `Bearer ${replacementToken}`
  )
  expect(
    local.remote.traffic.filter((entry) => entry.path === tokenPath)
  ).toHaveLength(2)
})

// Protect cancellation of native sends while the official SDK acquires tokens.
// A canceled message must not be posted or prevent another send from succeeding.
// Existing serial cases do not overlap authentication; no additional seam is used.
it('does not send an aborted message while another send completes its SDK authentication', async () => {
  const local = await setup()
  const input = await sendInput(local)
  const controller = new AbortController()
  const release = local.remote.holdToken()
  const canceled = local.plugin.send({ ...input, signal: controller.signal })
  const surviving = local.plugin.send(input)
  try {
    await expect
      .poll(
        () =>
          local.remote.traffic.filter((entry) => entry.path === tokenPath)
            .length
      )
      .toBeGreaterThan(0)
    controller.abort()
    release()
    expect(await canceled).toMatchObject({
      status: 'unknown',
      errorCode: 'transport_or_response_unknown'
    })
    release()
    expect(await surviving).toMatchObject({ status: 'sent' })
    expect(
      local.remote.traffic.filter((entry) => entry.path.startsWith('/teams/v3'))
    ).toHaveLength(1)
  } finally {
    release()
    await Promise.all([canceled, surviving])
  }
})

// SDK token failures must not post an unauthenticated message. Existing message
// Status tests do not count physical token exchanges. MSAL owns token throttling;
// Only message retries remain a Core contract. This uses the same HTTP peer.
it.each([429, 503])(
  'returns OAuth HTTP %s without posting an unauthenticated message',
  async (status) => {
    const local = await setup()
    const input = await sendInput(local)
    local.remote.token(
      status,
      { error: 'temporarily_unavailable' },
      { 'retry-after': '60' }
    )
    expect(await local.plugin.send(input)).toEqual({
      status: 'retryable',
      errorCode: 'oauth_unavailable'
    })
    expect(
      local.remote.traffic.filter((entry) => entry.path.startsWith('/teams/v3'))
    ).toHaveLength(0)
  }
)

it('reposts a personal file consent card with fresh OAuth after a definitive 401', async () => {
  // Bot Connector rejects an expired bearer credential with HTTP 401:
  // https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
  // Teams FileConsentCard is an outbound activity with an acceptContext:
  // https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/file-upload
  const local = await setup()

  const incoming = {
    ...local.activity,
    conversation: {
      ...local.activity.conversation,
      conversationType: 'personal'
    }
  }

  expect(
    (await local.core.fetch(await local.incoming({}, incoming))).status
  ).toBe(200)
  const record = (await local.storage.listInbound({ limit: 1 }))[0]?.snapshot
  if (!record) {
    throw new Error('missing_incoming_activity')
  }

  const principal = local.principal()

  const reference = await principal.media?.upload({
    channelId: record.channel.id,
    mediaId: '74733a43-9676-4dd8-9051-0233ddc6eec1',
    upload: {
      kind: 'file',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      data: new Uint8Array([10, 20, 30, 40])
    }
  })

  if (!reference) {
    throw new Error('missing_file')
  }

  const media = await principal.media?.read({
    channelId: record.channel.id,
    mediaId: reference.id
  })

  if (!media) {
    throw new Error('missing_file_bytes')
  }

  const input: SendInput = {
    deliveryId: 'consent-401',
    channelId: record.channel.id,
    target: record.target,
    chunkIndex: 0,
    chunk: {
      text: '',
      state: null,
      idempotencyKey: 'consent-401:0',
      media: media.reference
    },
    media,
    signal: new AbortController().signal
  }

  const namespace = { pluginId: 'channel-msteams', ownerId: 'business' }
  const consentKey = 'consent:consent-401:0'
  const expiredToken = oauthToken('expired-token')

  local.remote.token(200, {
    access_token: expiredToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  local.remote.respond(401, { error: { code: 'Unauthorized' } })
  expect(await local.plugin.send(input)).toEqual({
    status: 'retryable',
    errorCode: 'oauth_token_rejected'
  })
  expect(await local.storage.getState(namespace, consentKey)).toBeUndefined()

  const replacementToken = oauthToken('replacement-token')
  local.remote.token(200, {
    access_token: replacementToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  local.remote.respond(200, { id: 'consent-card' })
  expect(await local.plugin.send(input)).toEqual({
    status: 'pending',
    retryAfterMs: 30_000
  })
  expect(await local.plugin.send(input)).toMatchObject({ status: 'pending' })
  expect(
    (await local.storage.getState(namespace, consentKey))?.value
  ).toMatchObject({
    phase: 'waiting',
    conversationId: 'conversation-1',
    userId: 'user-id'
  })

  const posts = local.remote.traffic.filter((entry) =>
    entry.path.endsWith('/activities')
  )

  expect(posts).toHaveLength(2)
  expect(posts.map((entry) => entry.headers.authorization)).toEqual([
    `Bearer ${expiredToken}`,
    `Bearer ${replacementToken}`
  ])
  expect(posts.map((entry) => JSON.parse(entry.body) as unknown)).toMatchObject(
    [
      {
        attachments: [
          { contentType: 'application/vnd.microsoft.teams.card.file.consent' }
        ]
      },
      {
        attachments: [
          { contentType: 'application/vnd.microsoft.teams.card.file.consent' }
        ]
      }
    ]
  )
  expect(
    local.remote.traffic.filter((entry) => entry.path === tokenPath)
  ).toHaveLength(2)
})

// Token and expiry validation protects the external protocol boundary, independently
// Of the library's permissive parser; ordinary successful fixtures cannot detect this.
// https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
it.each([
  { access_token: 123, expires_in: 3600 },
  { access_token: 'bad-expiry', expires_in: 'invalid' },
  { access_token: 'missing-expiry' }
])(
  'rejects malformed Teams OAuth response %j without poisoning later grants',
  async (response) => {
    const local = await setup()
    const input = await sendInput(local)
    local.remote.token(200, response)
    expect(await local.plugin.send(input)).toEqual({
      status: 'retryable',
      errorCode: 'oauth_unavailable'
    })
    expect(
      local.remote.traffic.filter((entry) => entry.path.startsWith('/teams/v3'))
    ).toHaveLength(0)
    const validToken = oauthToken('valid-token')
    local.remote.token(200, {
      access_token: validToken,
      token_type: 'Bearer',
      expires_in: 3600
    })
    expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
    expect(local.remote.traffic.at(-1)?.headers.authorization).toBe(
      `Bearer ${validToken}`
    )
    expect(
      local.remote.traffic.filter((entry) => entry.path === tokenPath)
    ).toHaveLength(2)
  }
)

// Shared media authentication must invalidate rejected cached credentials before
// Webhook redelivery. Existing recovery coverage has no cached OAuth rejection.
// This exercises HTTP ingestion and real SQLite rather than a persistence peer.
it('refreshes a rejected Teams media token on redelivery before persisting bytes', async () => {
  const local = await setup()

  const incoming = {
    ...local.activity,
    text: '',
    attachments: [
      {
        contentType: 'image/png',
        contentUrl: `${local.remote.base}/protected-image`,
        name: 'image.png'
      }
    ]
  }

  local.remote.route('/protected-image', { error: 'unauthorized' }, {}, 401)
  expect(
    (await local.core.fetch(await local.incoming({}, incoming))).status
  ).toBe(500)
  expect(await local.storage.listInbound({ limit: 1 })).toHaveLength(0)
  const freshMediaToken = oauthToken('fresh-media-token')
  local.remote.token(200, {
    access_token: freshMediaToken,
    token_type: 'Bearer',
    expires_in: 3600
  })
  local.remote.route('/protected-image', new Uint8Array([1, 2, 3]), {
    'content-type': 'image/png'
  })
  expect(
    (await local.core.fetch(await local.incoming({}, incoming))).status
  ).toBe(200)
  expect(
    (await local.storage.listInbound({ limit: 1 }))[0]?.snapshot.attachments
  ).toMatchObject([{ kind: 'image', size: 3 }])
  expect(
    local.remote.traffic
      .filter((entry) => entry.path === '/protected-image')
      .map((entry) => entry.headers.authorization)
  ).toEqual([
    `Bearer ${local.remote.defaultToken}`,
    `Bearer ${freshMediaToken}`
  ])
  expect(
    local.remote.traffic.filter((entry) => entry.path === tokenPath)
  ).toHaveLength(2)
})

// Native quotation uses the source message ID in a quotedReply entity and text
// Placeholder; threading independently targets the original root activity:
// https://github.com/microsoft/teams.ts/blob/main/packages/api/src/activities/message/message.ts
// https://microsoft.github.io/teams-sdk/blog/quoted-and-threaded-replies/
it('quotes three selected requests out of order without moving replies out of the bound thread', async () => {
  const local = await setup()
  for (const id of ['1800000000001', '1800000000002', '1800000000003']) {
    expect(
      (
        await local.core.fetch(
          await local.incoming({}, { ...local.activity, id, text: id })
        )
      ).status
    ).toBe(200)
  }
  const incoming = await local.storage.listInbound({ limit: 10 })
  expect(incoming).toHaveLength(3)
  for (const id of ['1800000000002', '1800000000001', '1800000000003']) {
    const request = incoming.find((item) => item.snapshot.text === id)?.snapshot
    if (!request) {
      throw new Error('missing_incoming_activity')
    }
    expect(
      await local.principal().sendMessage({
        channel: request.channel.id,
        text: `answer ${id}`,
        reply: { requestId: request.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await local.core.processDue()
  }
  const channel = incoming[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await local.principal().sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await local.core.processDue()

  const sent = local.remote.traffic.filter((item) =>
    item.path.includes('/activities')
  )

  expect(sent.map((item) => item.path)).toEqual([
    '/teams/v3/conversations/conversation-1/activities',
    '/teams/v3/conversations/conversation-1/activities',
    '/teams/v3/conversations/conversation-1/activities',
    '/teams/v3/conversations/conversation-1/activities'
  ])
  expect(sent.map((item) => JSON.parse(item.body) as unknown)).toMatchObject([
    {
      text: '<quoted messageId="1800000000002"/> answer 1800000000002',
      entities: [
        { type: 'quotedReply', quotedReply: { messageId: '1800000000002' } }
      ],
      replyToId: 'root-1'
    },
    {
      text: '<quoted messageId="1800000000001"/> answer 1800000000001',
      entities: [
        { type: 'quotedReply', quotedReply: { messageId: '1800000000001' } }
      ],
      replyToId: 'root-1'
    },
    {
      text: '<quoted messageId="1800000000003"/> answer 1800000000003',
      entities: [
        { type: 'quotedReply', quotedReply: { messageId: '1800000000003' } }
      ],
      replyToId: 'root-1'
    },
    { text: 'ordinary', replyToId: 'root-1' }
  ])
  expect(JSON.parse(sent[3]?.body ?? 'null') as unknown).not.toHaveProperty(
    'entities'
  )
})

it('uses the selected activity for root-conversation replies and keeps ordinary sends outside that reply chain', async () => {
  const local = await setup()

  const root = await harness(
    createTeamsChannel(),
    local.config,
    'conversation-1',
    'user-id'
  )

  cleanup.push(root.close)
  const { replyToId: _thread, ...activity } = local.activity
  expect(
    (await root.core.fetch(await local.incoming({}, activity))).status
  ).toBe(200)
  const request = (await root.storage.listInbound({ limit: 1 }))[0]?.snapshot
  if (!request) {
    throw new Error('missing_incoming_activity')
  }
  expect(
    await root.principal().sendMessage({
      channel: request.channel.id,
      text: 'answer',
      reply: { requestId: request.requestId, kind: 'final' }
    })
  ).toMatchObject({ status: 'queued' })
  await root.core.processDue()
  expect(
    await root
      .principal()
      .sendMessage({ channel: request.channel.id, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await root.core.processDue()

  const sent = local.remote.traffic.filter((item) =>
    item.path.includes('/activities')
  )

  expect(sent.map((item) => item.path)).toEqual([
    '/teams/v3/conversations/conversation-1/activities',
    '/teams/v3/conversations/conversation-1/activities'
  ])
  expect(JSON.parse(sent[0]?.body ?? 'null') as unknown).toMatchObject({
    text: '<quoted messageId="activity-1"/> answer',
    entities: [
      { type: 'quotedReply', quotedReply: { messageId: 'activity-1' } }
    ]
  })
  const ordinary: unknown = JSON.parse(sent[1]?.body ?? 'null')
  expect(ordinary).toMatchObject({ text: 'ordinary' })
  expect(ordinary).not.toHaveProperty('entities')
  expect(ordinary).not.toHaveProperty('replyToId')
})

async function setup(
  endorsements = ['msteams'],
  filename = ':memory:',
  publicUrl?: string,
  tokenUrl?: string,
  worker?: CoreOptions['worker']
): Promise<{
  core: CoreRuntime
  storage: Storage
  dispatches: string[]
  principal(this: void): ScopedAgentHost
  sendReply(
    this: void,
    text?: string
  ): Promise<{
    request: InboundSnapshot
    delivery: OutboundRecord | undefined
  }>
  close(this: void): Promise<void>
  remote: Awaited<ReturnType<typeof peer>>
  config: Readonly<Record<string, Json>>
  plugin: ReturnType<typeof createTeamsChannel>
  activity: {
    type: string
    id: string
    channelId: string
    serviceUrl: string
    text: string
    from: { id: string }
    recipient: { id: string }
    conversation: { id: string; tenantId: string }
    channelData: { tenant: { id: string } }
    replyToId: string
  }
  incoming(
    this: void,
    claims?: {
      iss?: string
      aud?: string
      serviceurl?: string
      exp?: string
    },
    body?: unknown
  ): Promise<Request>
}> {
  vi.stubEnv('TEAMS_SECRET', 'app-secret')
  const remote = await peer()
  cleanup.push(remote.close)
  const keys = await generateKeyPair('RS256')
  remote.keys({
    keys: [
      { ...(await exportJWK(keys.publicKey)), kid: 'teams-key', endorsements }
    ]
  })
  remote.respond(200, { id: 'activity-sent' })

  const config: Json = {
    appId: 'app-id',
    botId: 'bot-id',
    tenantId: 'tenant-id',
    appSecret: { env: 'TEAMS_SECRET' },
    ...(tokenUrl ? { tokenUrl } : {}),
    trustedServiceOrigins: [remote.base],
    trustedUploadOrigins: [remote.base]
  }

  const plugin = createTeamsChannel()

  const local = await harness(
    plugin,
    config,
    'conversation-1',
    'user-id',
    'root-1',
    filename,
    publicUrl,
    worker
  )

  cleanup.push(local.close)

  const activity = {
    type: 'message',
    id: 'activity-1',
    channelId: 'msteams',
    serviceUrl: `${remote.base}/teams/`,
    text: 'hello',
    from: { id: 'user-id' },
    recipient: { id: 'bot-id' },
    conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
    channelData: { tenant: { id: 'tenant-id' } },
    replyToId: 'root-1'
  }

  async function incoming(
    claims: {
      iss?: string
      aud?: string
      serviceurl?: string
      exp?: string
    } = {},
    body: unknown = activity
  ): Promise<Request> {
    const token = await new SignJWT({
      serviceurl: claims.serviceurl ?? activity.serviceUrl
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'teams-key' })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? 'app-id')
      .setIssuedAt()
      .setNotBefore('-1s')
      .setExpirationTime(claims.exp ?? '5m')
      .sign(keys.privateKey)

    return new Request('http://local/channels/business/activities', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
  }

  return { remote, config, plugin, activity, incoming, ...local }
}

describe('native Microsoft Teams', () => {
  it.each([
    {
      name: 'declared file bytes',
      sizes: [5],
      headers: { 'content-length': '5' },
      worker: { maxMediaBytes: 4 }
    },
    {
      name: 'streamed file bytes',
      sizes: [5],
      headers: { 'transfer-encoding': 'chunked' },
      worker: { maxMediaBytes: 4 }
    },
    {
      name: 'attachment count',
      sizes: [3, 3],
      headers: {},
      worker: { maxMediaBytes: 4, maxAttachments: 1 }
    },
    {
      name: 'aggregate file bytes',
      sizes: [3, 3],
      headers: {},
      worker: { maxMediaBytes: 4, maxTotalMediaBytes: 5 }
    }
  ])(
    'acknowledges local $name rejection without saving or dispatching the rejected activity',
    async ({ sizes, headers, worker }) => {
      const local = await setup(
        ['msteams'],
        ':memory:',
        undefined,
        undefined,
        worker
      )

      // Native personal-chat file download envelope:
      // Microsoft/botbuilder-js@63ebf76bff71db0f7dad067624e2fc3faf342898
      // Libraries/botframework-schema/src/teams/index.ts:1171-1192 (FileDownloadInfo).
      // https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-files#receive-files-in-personal-chat
      for (const [index, size] of sizes.entries()) {
        local.remote.route(
          `/bounded-file-${index}`,
          new Uint8Array(size).fill(65),
          {
            ...headers,
            'content-type': 'text/plain'
          }
        )
      }

      const incoming = {
        ...local.activity,
        conversation: {
          ...local.activity.conversation,
          conversationType: 'personal'
        },
        attachments: sizes.map((_size, index) => ({
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: `file-${index}.txt`,
          content: {
            downloadUrl: `${local.remote.base}/bounded-file-${index}`,
            uniqueId: `bounded-file-${index}`,
            fileType: 'txt'
          }
        }))
      }

      expect(
        (await local.core.fetch(await local.incoming({}, incoming))).status
      ).toBe(200)
      expect(
        (await local.core.fetch(await local.incoming({}, incoming))).status
      ).toBe(200)
      expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
      await local.core.processDue()
      expect(local.dispatches).toEqual([])

      const following = {
        ...local.activity,
        id: 'following-text',
        text: 'following legal text'
      }

      expect(
        (await local.core.fetch(await local.incoming({}, following))).status
      ).toBe(200)
      await local.core.processDue()
      expect(local.dispatches).toEqual(['following legal text'])
      expect(await local.storage.listInbound({ limit: 10 })).toHaveLength(1)

      const downloads = local.remote.traffic.filter((entry) =>
        entry.path.startsWith('/bounded-file-')
      )

      expect(downloads).toHaveLength(sizes.length * 2)
      expect(
        downloads.every((entry) => entry.headers.authorization === undefined)
      ).toBe(true)
    }
  )

  it('leaves native file download failures replayable and dispatches recovered bytes after SQLite reopen', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'relanox-teams-download-retry-')
    )

    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'state.db')

    const local = await setup(['msteams'], filename, undefined, undefined, {
      maxMediaBytes: 4
    })

    const incoming = {
      ...local.activity,
      text: 'recover this file',
      conversation: {
        ...local.activity.conversation,
        conversationType: 'personal'
      },
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'recover.txt',
          content: {
            downloadUrl: `${local.remote.base}/recover-file`,
            uniqueId: 'recover-file',
            fileType: 'txt'
          }
        }
      ]
    }

    // Same FileDownloadInfo contract as the local-policy cases above.
    local.remote.route('/recover-file', {}, {}, 503)
    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(500)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    local.remote.route('/recover-file', new Uint8Array([65, 66, 67]), {
      'content-type': 'text/plain'
    })
    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(200)
    await local.close()

    const reopened = await harness(
      createTeamsChannel(),
      local.config,
      'conversation-1',
      'user-id',
      'root-1',
      filename,
      undefined,
      { maxMediaBytes: 4 }
    )

    cleanup.push(reopened.close)
    await reopened.core.processDue()
    expect(reopened.dispatches).toEqual(['recover this file'])

    const item = (await reopened.storage.listInbound({ limit: 10 }))[0]
      ?.snapshot

    const attachment = item?.attachments?.[0]
    if (!item || !attachment) {
      throw new Error('missing_recovered_file')
    }
    expect(
      await reopened
        .principal()
        .media?.read({ channelId: item.channel.id, mediaId: attachment.id })
    ).toMatchObject({
      data: new Uint8Array([65, 66, 67]),
      reference: { fileName: 'recover.txt', size: 3 }
    })
    await reopened.close()
    expect(
      (
        await reopened.core.fetch(
          await local.incoming(
            {},
            {
              ...incoming,
              id: 'storage-unavailable'
            }
          )
        )
      ).status
    ).toBe(500)
  })

  it('checks the account sender allowlist before authenticated attachment downloads', async () => {
    const local = await setup()
    // Bot Connector image contentUrl contract:
    // Microsoft/botbuilder-js@63ebf76bff71db0f7dad067624e2fc3faf342898
    // Libraries/botframework-schema/src/index.ts:382-403 (Attachment)
    local.remote.route('/image', new Uint8Array([1, 2, 3]), {
      'content-type': 'image/png'
    })

    const incoming = {
      ...local.activity,
      from: { id: 'unauthorized-user' },
      attachments: [
        { contentType: 'image/png', contentUrl: `${local.remote.base}/image` }
      ]
    }

    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(200)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    expect(local.remote.traffic.map((request) => request.path)).toEqual([
      '/v1/.well-known/keys'
    ])
  })

  // Microsoft Teams wire example: attachments contain the HTML representation of text.
  // https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability#receive-a-message-activity
  it('accepts native HTML message representations without downloading them as files', async () => {
    const local = await setup()

    const incoming = {
      ...local.activity,
      text: 'Hello Teams TestAgent.Sending bold-italic rich text',
      attachments: [
        {
          contentType: 'text/html',
          content:
            '<div>Hello Teams TestAgent. Sending <strong>bold</strong>-<em>italic</em> rich text.</div>'
        }
      ]
    }

    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(200)
    const completed = await local.sendReply()
    expect(local.dispatches).toEqual([
      'Hello Teams TestAgent.Sending bold-italic rich text'
    ])
    expect(completed.request.attachments).toBeUndefined()
    expect(completed.delivery?.status).toBe('sent')
    expect(local.remote.traffic.map((request) => request.path)).not.toContain(
      '/file'
    )
  })

  it('uses the application registration authority independently of the allowed inbound tenant', async () => {
    const local = await setup(
      ['msteams'],
      ':memory:',
      undefined,
      'https://login.microsoftonline.com/app-registration-tenant/oauth2/v2.0/token'
    )

    const accessToken = oauthToken('single-tenant-token')
    local.remote.route('/app-registration-tenant/oauth2/v2.0/token', {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600
    })
    expect((await local.core.fetch(await local.incoming())).status).toBe(200)
    const result = await local.sendReply()
    expect(result.delivery?.status).toBe('sent')

    const token = local.remote.traffic.find(
      (request) => request.path === '/app-registration-tenant/oauth2/v2.0/token'
    )

    expect(new URLSearchParams(token?.body).get('client_id')).toBe('app-id')
    expect(
      local.remote.traffic.find((request) =>
        request.path.includes('/activities')
      )?.headers.authorization
    ).toBe(`Bearer ${accessToken}`)
  })

  it.each(['?', '#'])(
    "rejects a signed service base with a bare '%s' delimiter",
    async (suffix) => {
      const local = await setup()
      const serviceUrl = `${local.activity.serviceUrl}${suffix}`

      const response = await local.core.fetch(
        await local.incoming(
          { serviceurl: serviceUrl },
          { ...local.activity, serviceUrl }
        )
      )

      expect(response.status).toBe(403)
      expect((await local.storage.getStats()).pending).toBe(0)
    }
  )

  // Preserve exact issued credentials even when assertions cross a clock second.
  // Rebuilding the expected JWT changes exp; ordinary fast sends may miss that
  // Fixture race. Real SDK HTTP and SQLite need no production testing interface.
  it('authenticates endorsed JWT and frozen conversation reference through proactive OAuth send', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const local = await setup()
    expect((await local.core.fetch(await local.incoming({}, '{'))).status).toBe(
      400
    )
    expect((await local.core.fetch(await local.incoming())).status).toBe(200)
    expect((await local.core.fetch(await local.incoming())).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)

    const completed = await local.sendReply(
      '**answer** [link](https://example.com)'
    )

    vi.setSystemTime(Date.now() + 1000)
    expect(completed.delivery?.status).toBe('sent')
    expect(local.dispatches).toEqual(['hello'])
    expect(completed.request.target).toEqual({
      channel: 'msteams',
      accountId: 'business',
      chatId: 'conversation-1',
      threadId: 'root-1',
      replyToId: 'activity-1',
      data: {
        appId: 'app-id',
        serviceUrl: `${local.remote.base}/teams/`,
        conversationId: 'conversation-1',
        tenantId: 'tenant-id',
        botId: 'bot-id',
        userId: 'user-id',
        replyToId: 'root-1'
      }
    })

    const oauth = local.remote.traffic.find(
      (request) => request.path === '/botframework.com/oauth2/v2.0/token'
    )

    const form = new URLSearchParams(oauth?.body)
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'app-id',
      client_secret: 'app-secret',
      scope: 'https://api.botframework.com/.default'
    })

    const sent = local.remote.traffic.find((request) =>
      request.path.startsWith('/teams/v3')
    )

    expect(sent?.path).toBe('/teams/v3/conversations/conversation-1/activities')
    expect(sent?.headers.authorization).toBe(
      `Bearer ${local.remote.defaultToken}`
    )
    expect(JSON.parse(sent?.body ?? 'null') as unknown).toMatchObject({
      type: 'message',
      textFormat: 'extendedmarkdown',
      text: '**answer** [link](https://example.com)',
      channelId: 'msteams',
      from: { id: 'bot-id' },
      recipient: { id: 'user-id' },
      conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
      replyToId: 'root-1',
      channelData: { tenant: { id: 'tenant-id' } }
    })
  })

  it.each([
    { aud: 'other-app' },
    { iss: 'https://attacker.example' },
    { exp: '-10m' }
  ])('rejects JWT outside application trust %j', async (claims) => {
    const local = await setup()
    expect((await local.core.fetch(await local.incoming(claims))).status).toBe(
      401
    )
    expect((await local.storage.getStats()).pending).toBe(0)
  })

  it('rejects wrong recipient/tenant/channel and untrusted JWT-bound service URLs through SDK authentication', async () => {
    const local = await setup()
    for (const body of [
      { ...local.activity, recipient: { id: 'other-bot' } },
      { ...local.activity, channelData: { tenant: { id: 'other-tenant' } } },
      { ...local.activity, channelId: 'emulator' }
    ]) {
      expect(
        (await local.core.fetch(await local.incoming({}, body))).status
      ).toBe(403)
    }
    expect(
      (
        await local.core.fetch(
          await local.incoming(
            { serviceurl: 'https://attacker.example/' },
            { ...local.activity, serviceUrl: 'https://attacker.example/' }
          )
        )
      ).status
    ).toBe(403)
    expect(
      (
        await local.core.fetch(
          await local.incoming({ serviceurl: 'https://mismatch.example/' })
        )
      ).status
    ).toBe(401)
    expect((await local.storage.getStats()).pending).toBe(0)
  })

  it.each(['application identity', 'service origin trust'])(
    'rejects frozen targets after %s changes across SQLite reopen',
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), 'relanox-teams-identity-'))
      cleanup.push(async () => rm(directory, { recursive: true, force: true }))
      const filename = join(directory, 'state.db')
      const local = await setup(['msteams'], filename)
      expect((await local.core.fetch(await local.incoming())).status).toBe(200)
      await local.close()
      const plugin = createTeamsChannel()

      const reopened = await harness(
        plugin,
        {
          ...local.config,
          ...(change === 'application identity'
            ? { appId: 'replacement-app' }
            : { trustedServiceOrigins: ['https://replacement.invalid'] })
        },
        'conversation-1',
        'user-id',
        'root-1',
        filename
      )

      cleanup.push(reopened.close)
      const item = (await reopened.storage.listInbound({ limit: 10 }))[0]
      if (!item) {
        throw new Error('Missing frozen target')
      }

      const input: SendInput = {
        deliveryId: 'delivery',
        channelId: item.snapshot.channel.id,
        chunkIndex: 0,
        signal: new AbortController().signal,
        target: item.snapshot.target,
        chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null }
      }

      expect(await plugin.send(input)).toMatchObject({ status: 'rejected' })
      expect(
        local.remote.traffic.filter((entry) =>
          entry.path.startsWith('/teams/v3')
        )
      ).toHaveLength(0)
      await reopened.close()
      vi.stubEnv('TEAMS_SECRET', 'rotated-secret')
      const restoredPlugin = createTeamsChannel()

      const restored = await harness(
        restoredPlugin,
        local.config,
        'conversation-1',
        'user-id',
        'root-1',
        filename
      )

      cleanup.push(restored.close)
      const legacy = z.record(z.string(), z.json()).parse(input.target.data)
      delete legacy.appId
      expect(
        await restoredPlugin.send({
          ...input,
          target: { ...input.target, data: legacy }
        })
      ).toMatchObject({ status: 'rejected' })
      expect(await restoredPlugin.send(input)).toMatchObject({ status: 'sent' })
    }
  )

  it.each([
    [503, 'pending'],
    [429, 'pending'],
    [401, 'rejected']
  ] as const)(
    'classifies OAuth HTTP %s before sending as %s',
    async (status, expected) => {
      const local = await setup()
      await local.core.fetch(await local.incoming())
      local.remote.token(status, {
        error: status === 401 ? 'invalid_client' : 'temporarily_unavailable'
      })

      const completed = await local.sendReply(
        '**answer** [link](https://example.com)'
      )

      expect(completed.delivery?.status).toBe(expected)
      expect(
        local.remote.traffic.filter((request) =>
          request.path.startsWith('/teams/v3')
        )
      ).toHaveLength(0)
      if (expected === 'pending') {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 61_000)
        local.remote.token(200, {
          access_token: oauthToken('recovered-token'),
          token_type: 'Bearer',
          expires_in: 3600
        })
        await expect
          .poll(
            async () => {
              await local.core.processDue()
              return (
                await local.storage.getOutbound(
                  completed.delivery?.deliveryId ?? 'missing'
                )
              )?.status
            },
            { timeout: 5000 }
          )
          .toBe('sent')
        expect(
          local.remote.traffic.filter((request) =>
            request.path.startsWith('/teams/v3')
          )
        ).toHaveLength(1)
      }
    }
  )

  it('forwards SDK OAuth tokens longer than entity identifiers intact', async () => {
    const local = await setup()
    const token = oauthToken('a'.repeat(2048))
    local.remote.token(200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600
    })
    await local.core.fetch(await local.incoming())
    expect((await local.sendReply()).delivery?.status).toBe('sent')

    const sent = local.remote.traffic.find((request) =>
      request.path.startsWith('/teams/v3')
    )

    expect(sent?.headers.authorization).toBe(`Bearer ${token}`)
  })

  it.each([
    [429, 'pending'],
    [403, 'rejected'],
    [503, 'unknown']
  ] as const)('classifies HTTP %s as %s', async (status, expected) => {
    const local = await setup()
    await local.core.fetch(await local.incoming())
    local.remote.respond(status, {}, { 'retry-after': '2' })
    expect((await local.sendReply()).delivery?.status).toBe(expected)
    expect(
      local.remote.traffic.filter((request) =>
        request.path.startsWith('/teams/v3')
      )
    ).toHaveLength(1)
  })

  it('rejects plain credentials and path-bearing trusted origins', () => {
    const plugin = createTeamsChannel()
    expect(() =>
      plugin.validateConfig({
        appId: 'app',
        botId: 'bot',
        tenantId: 'tenant',
        appSecret: 'secret',
        trustedServiceOrigins: ['https://smba.trafficmanager.net']
      })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        appId: 'app',
        botId: 'bot',
        tenantId: 'tenant',
        appSecret: { env: 'SECRET' },
        trustedServiceOrigins: ['https://smba.trafficmanager.net/teams']
      })
    ).toThrow('service_origins_must_be_origins')
  })
})

it.each([
  { conversationType: 'personal', size: 15_000, published: false },
  { conversationType: 'groupChat', size: 15_001, published: true },
  { conversationType: 'channel', size: 15_001, published: true }
])(
  'Teams sends $size image bytes in $conversationType with the required transport',
  async ({ conversationType, size, published }) => {
    const local = await setup(
      ['msteams'],
      ':memory:',
      published ? 'http://127.0.0.1:9999' : undefined
    )

    const bytes = new Uint8Array(size).fill(65)
    local.remote.route('/inline', bytes, { 'content-type': 'image/png' })

    const incoming = {
      ...local.activity,
      text: '',
      conversation: { ...local.activity.conversation, conversationType },
      attachments: [
        {
          contentType: 'image/png',
          contentUrl: `${local.remote.base}/inline`,
          name: 'image.png'
        }
      ]
    }

    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(200)
    const scoped = local.principal()
    const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
    if (!item?.attachments?.[0]) {
      throw new Error('missing_media')
    }
    await scoped.sendMessage({
      channel: item.channel.id,
      idempotencyKey: 'image-result',
      text: '',
      attachments: [item.attachments[0].id]
    })
    await local.core.processDue()

    const sent = local.remote.traffic.find((request) =>
      request.path.includes('/activities')
    )

    expect(JSON.parse(sent?.body ?? 'null') as unknown).toMatchObject({
      from: { id: 'bot-id' },
      recipient: { id: 'user-id' },
      replyToId: 'root-1',
      attachments: [
        {
          contentType: 'image/png',
          name: 'image.png'
        }
      ]
    })

    const attachment = z
      .object({ attachments: z.array(z.object({ contentUrl: z.string() })) })
      .parse(JSON.parse(sent?.body ?? 'null')).attachments[0]

    if (published) {
      expect(attachment?.contentUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:9999\/media\//u
      )
    } else {
      expect(attachment?.contentUrl).toBe(
        `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
      )
    }
    expect(
      local.remote.traffic.find((request) => request.path === '/inline')
        ?.headers.authorization
    ).toBe(`Bearer ${local.remote.defaultToken}`)
  }
)

it.each([
  {
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    fileType: 'pdf',
    bytes: new Uint8Array([10, 20, 30, 40])
  },
  {
    fileName: 'large.png',
    mimeType: 'image/png',
    fileType: 'png',
    bytes: new Uint8Array(15_001).fill(65)
  }
])(
  'Teams uploads $fileName through persistent personal consent without public media hosting',
  async ({ fileName, mimeType, fileType, bytes }) => {
    const directory = await mkdtemp(join(tmpdir(), 'relanox-teams-media-'))
    cleanup.push(async () => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'state.db')
    const local = await setup(['msteams'], filename)
    local.remote.route('/file', bytes, { 'content-type': mimeType })
    local.remote.route('/upload', {})

    const incoming = {
      ...local.activity,
      text: '',
      conversation: {
        ...local.activity.conversation,
        conversationType: 'personal'
      },
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: fileName,
          content: { downloadUrl: `${local.remote.base}/file` }
        }
      ]
    }

    expect(
      (await local.core.fetch(await local.incoming({}, incoming))).status
    ).toBe(200)
    const scoped = local.principal()
    const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
    if (!item?.attachments?.[0]) {
      throw new Error('missing_media')
    }

    const media = await scoped.media?.read({
      channelId: item.channel.id,
      mediaId: item.attachments[0].id
    })

    if (!media) {
      throw new Error('missing_media_bytes')
    }

    const input: SendInput = {
      deliveryId: 'file-delivery',
      channelId: item.channel.id,
      target: item.target,
      chunkIndex: 0,
      chunk: {
        text: '',
        state: null,
        idempotencyKey: 'file:0',
        media: media.reference
      },
      media,
      signal: new AbortController().signal
    }

    // Connector 429 and Retry-After contract:
    // https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit
    local.remote.respond(
      429,
      { error: { code: 'Throttled' } },
      { 'retry-after': '1' }
    )
    expect(await local.plugin.send(input)).toMatchObject({
      status: 'retryable',
      errorCode: 'rate_limited'
    })
    local.remote.respond(200, { id: 'activity-sent' })
    expect(await local.plugin.send(input)).toMatchObject({
      status: 'pending',
      retryAfterMs: 30_000
    })
    expect(await local.plugin.send(input)).toMatchObject({
      status: 'pending',
      retryAfterMs: 30_000
    })
    expect(
      local.remote.traffic.filter((request) =>
        request.path.includes('/activities')
      )
    ).toHaveLength(2)
    await local.close()
    const plugin = createTeamsChannel()

    const restarted = await harness(
      plugin,
      local.config,
      'conversation-1',
      'user-id',
      'root-1',
      filename
    )

    cleanup.push(restarted.close)

    const resumed = await restarted.principal().media?.read({
      channelId: item.channel.id,
      mediaId: media.reference.id
    })

    if (!resumed) {
      throw new Error('missing_restored_media')
    }
    const resumedInput = { ...input, media: resumed }
    expect(await plugin.send(resumedInput)).toMatchObject({
      status: 'pending',
      retryAfterMs: 30_000
    })

    const invoke = {
      ...local.activity,
      type: 'invoke',
      name: 'fileConsent/invoke',
      value: {
        action: 'accept',
        context: { consentId: 'file:0' },
        uploadInfo: {
          uploadUrl: `${local.remote.base}/upload`,
          contentUrl: `https://tenant.sharepoint.com/${fileName}`,
          uniqueId: 'file-id',
          fileType
        }
      }
    }

    expect(
      (await restarted.core.fetch(await local.incoming({}, invoke))).status
    ).toBe(200)
    local.remote.disconnectOnce('/upload')
    expect(await plugin.send(resumedInput)).toMatchObject({
      status: 'retryable',
      errorCode: 'media_preparation_unavailable'
    })
    expect(
      local.remote.traffic.filter((request) =>
        request.path.includes('/activities')
      )
    ).toHaveLength(2)
    expect(await plugin.send(resumedInput)).toMatchObject({ status: 'sent' })

    const uploaded = local.remote.traffic.find(
      (request) => request.path === '/upload'
    )

    expect(Buffer.from(uploaded?.body ?? '', 'utf8')).toEqual(
      Buffer.from(bytes)
    )
    expect(uploaded?.headers['content-range']).toBe(
      `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`
    )
    expect(uploaded?.headers.authorization).toBeUndefined()

    const sent = local.remote.traffic.filter((request) =>
      request.path.includes('/activities')
    )

    expect(JSON.parse(sent[2]?.body ?? 'null') as unknown).toMatchObject({
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.card.file.info',
          content: { uniqueId: 'file-id', fileType }
        }
      ]
    })
  }
)

it('keeps personal file consent pending beyond the failure budget and delivers after SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-teams-consent-wait-'))
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'state.db')
  const local = await setup(['msteams'], filename)

  const incoming = {
    ...local.activity,
    conversation: {
      ...local.activity.conversation,
      conversationType: 'personal'
    }
  }

  expect(
    (await local.core.fetch(await local.incoming({}, incoming))).status
  ).toBe(200)
  const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
  if (!item) {
    throw new Error('missing_inbound')
  }
  const principal = local.principal()

  const file = await principal.media?.upload({
    channelId: item.channel.id,
    mediaId: '717187d4-31d0-4c37-9d2b-4817e3efbff5',
    upload: {
      kind: 'file',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      data: new Uint8Array([10, 20, 30, 40])
    }
  })

  if (!file) {
    throw new Error('missing_file')
  }

  const queued = await principal.sendMessage({
    channel: item.channel.id,
    text: '',
    attachments: [file.id],
    idempotencyKey: 'delayed-consent'
  })

  if (queued.status !== 'queued') {
    throw new Error('file_not_queued')
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  await local.core.processDue()
  for (let wait = 0; wait < 9; wait += 1) {
    vi.setSystemTime(Date.now() + 31_000)
    await local.core.processDue()
  }
  expect(await local.storage.getOutbound(queued.deliveryId)).toMatchObject({
    status: 'pending',
    attempts: 0
  })

  const cards = local.remote.traffic.filter((entry) =>
    entry.path.includes('/activities')
  )

  expect(cards).toHaveLength(1)

  // FileConsentCard acceptContext is echoed in FileConsentCardResponse.context:
  // Microsoft/botbuilder-js@63ebf76bff71db0f7dad067624e2fc3faf342898
  // Libraries/botframework-schema/src/teams/index.ts:1144-1270.
  const card = z
    .object({
      attachments: z.array(
        z.object({
          content: z.object({
            acceptContext: z.object({ consentId: z.string() })
          })
        })
      )
    })
    .parse(JSON.parse(cards[0]?.body ?? 'null'))

  const consentId = card.attachments[0]?.content.acceptContext.consentId
  if (!consentId) {
    throw new Error('missing_consent_id')
  }
  await local.close()

  const reopened = await harness(
    createTeamsChannel(),
    local.config,
    'conversation-1',
    'user-id',
    'root-1',
    filename
  )

  cleanup.push(reopened.close)
  local.remote.route('/upload-delayed', {})

  const invoke = {
    ...incoming,
    type: 'invoke',
    name: 'fileConsent/invoke',
    value: {
      type: 'fileUpload',
      action: 'accept',
      context: { consentId },
      uploadInfo: {
        uploadUrl: `${local.remote.base}/upload-delayed`,
        contentUrl: 'https://tenant.sharepoint.com/report.pdf',
        uniqueId: 'delayed-file',
        fileType: 'pdf'
      }
    }
  }

  expect(
    (await reopened.core.fetch(await local.incoming({}, invoke))).status
  ).toBe(200)
  expect(
    (await reopened.core.fetch(await local.incoming({}, invoke))).status
  ).toBe(200)
  vi.setSystemTime(Date.now() + 31_000)
  await reopened.core.processDue()
  expect(await reopened.storage.getOutbound(queued.deliveryId)).toMatchObject({
    status: 'sent'
  })
  expect(
    local.remote.traffic.filter((entry) => entry.path === '/upload-delayed')
  ).toHaveLength(1)

  const messages = local.remote.traffic.filter((entry) =>
    entry.path.includes('/activities')
  )

  expect(messages).toHaveLength(2)
  expect(JSON.parse(messages[1]?.body ?? 'null') as unknown).toMatchObject({
    attachments: [
      {
        contentType: 'application/vnd.microsoft.teams.card.file.info',
        content: { uniqueId: 'delayed-file', fileType: 'pdf' }
      }
    ]
  })
})

it('learns trusted Teams installation context without an incoming message and keeps configured thread routing', async () => {
  const local = await setup()

  const address = {
    id: 'channel',
    platform: 'msteams' as const,
    accountId: 'business',
    chatId: 'conversation-1',
    threadId: 'root-1'
  }

  expect(await local.plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'address_unresolved'
  })
  const update = { ...local.activity, type: 'conversationUpdate', text: '' }
  expect(
    (await local.core.fetch(await local.incoming({ aud: 'wrong-app' }, update)))
      .status
  ).toBe(401)
  expect(await local.plugin.resolveChannel?.(address)).toEqual({
    status: 'unavailable',
    reason: 'address_unresolved'
  })
  expect(
    (await local.core.fetch(await local.incoming({}, update))).status
  ).toBe(200)
  expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
  const resolved = await local.plugin.resolveChannel?.(address)
  if (resolved?.status !== 'available') {
    throw new Error('missing_conversation_context')
  }
  expect(resolved.target.replyToId).toBeUndefined()
  expect(resolved.target).toMatchObject({
    threadId: 'root-1',
    data: { replyToId: 'root-1' }
  })

  const input: SendInput = {
    deliveryId: 'installation-delivery',
    channelId: 'channel',
    target: resolved.target,
    chunkIndex: 0,
    chunk: { text: 'hello', idempotencyKey: 'installation:0', state: null },
    signal: new AbortController().signal
  }

  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })
  expect(
    local.remote.traffic.find((item) => item.path.includes('/activities'))?.path
  ).toBe('/teams/v3/conversations/conversation-1/activities')

  const old = {
    ...resolved.target,
    data: {
      ...(resolved.target.data as Record<string, Json>),
      appId: 'old-app'
    }
  }

  expect(await local.plugin.resolveChannel?.(address, old)).toMatchObject({
    status: 'available'
  })
  expect(await local.plugin.send({ ...input, target: old })).toEqual({
    status: 'rejected',
    errorCode: 'invalid_target'
  })
  const { threadId: _thread, ...topAddress } = address
  const top = await local.plugin.resolveChannel?.(topAddress)
  if (top?.status !== 'available') {
    throw new Error('missing_conversation_context')
  }
  expect(top.target.data).not.toHaveProperty('replyToId')
})

it('publishes verified images and preserves text/image/text order in native rich messages', async () => {
  const local = await setup(['msteams'], ':memory:', 'https://relay.example')
  expect((await local.core.fetch(await local.incoming())).status).toBe(200)
  const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
  if (!item) {
    throw new Error('missing_inbound')
  }
  const principal = local.principal()

  const reference = await principal.media?.upload({
    channelId: item.channel.id,
    mediaId: 'c0ffef01-ecf3-46f3-bb31-7ae8c2865f51',
    upload: {
      kind: 'image',
      mimeType: 'image/png',
      fileName: 'photo.png',
      data: new Uint8Array([1, 2, 3, 4, 5])
    }
  })

  if (!reference) {
    throw new Error('missing_image')
  }

  const media = await principal.media?.read({
    channelId: item.channel.id,
    mediaId: reference.id
  })

  if (!media) {
    throw new Error('missing_image_bytes')
  }

  const input: SendInput = {
    deliveryId: 'rich',
    channelId: item.channel.id,
    target: item.target,
    chunkIndex: 0,
    signal: new AbortController().signal,
    chunk: {
      text: '',
      state: null,
      idempotencyKey: 'rich',
      richText: [
        { type: 'text', text: '**before**' },
        { type: 'image', media: reference, label: 'photo' },
        { type: 'text', text: 'after' }
      ]
    },
    richMedia: [media]
  }

  expect(await local.plugin.send(input)).toMatchObject({ status: 'sent' })

  const sent = local.remote.traffic.filter((request) =>
    request.path.includes('/activities')
  )

  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0]?.body ?? 'null') as unknown).toMatchObject({
    textFormat: 'extendedmarkdown',
    conversation: { id: 'conversation-1', tenantId: 'tenant-id' },
    replyToId: 'root-1'
  })

  // Native card body and attachment envelope documented by Microsoft:
  // https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference#adaptive-card
  expect(JSON.parse(sent[0]?.body ?? 'null') as unknown).toMatchObject({
    text: '',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.2',
          body: [
            { type: 'TextBlock', text: '**before**', wrap: true },
            {
              type: 'Image',
              altText: 'photo',
              url: expect.stringMatching(
                /^https:\/\/relay\.example\/media\//u
              ) as unknown
            },
            { type: 'TextBlock', text: 'after', wrap: true }
          ]
        }
      }
    ]
  })
  const count = local.remote.traffic.length
  expect(await local.plugin.send({ ...input, richMedia: [] })).toMatchObject({
    status: 'rejected',
    errorCode: 'invalid_rich_media'
  })
  expect(
    await local.plugin.send({
      ...input,
      chunk: {
        ...input.chunk,
        richText: [
          { type: 'text', text: 'a'.repeat(2001) },
          { type: 'image', media: reference, label: 'photo' }
        ]
      }
    })
  ).toMatchObject({ status: 'rejected', errorCode: 'rich_text_limit_exceeded' })
  expect(local.remote.traffic).toHaveLength(count)
})

// Protect the full Core budget and native resumable upload across a real restart.
// A single PUT above 60 MiB or lost fragment checkpoints rejects/duplicates bytes;
// Existing four-byte and 15,001-byte consent cases cannot detect either regression.
// Uses the existing channel/SQLite APIs and a peer implementing only upload HTTP.
// https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
it('sends the 100 MiB file budget in native fragments and resumes consent uploads after SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-teams-fragments-'))
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'state.db')
  const local = await setup(['msteams'], filename)

  const incoming = {
    ...local.activity,
    conversation: {
      ...local.activity.conversation,
      conversationType: 'personal'
    }
  }

  expect(
    (await local.core.fetch(await local.incoming({}, incoming))).status
  ).toBe(200)
  const item = (await local.storage.listInbound({ limit: 1 }))[0]?.snapshot
  if (!item) {
    throw new Error('missing_inbound')
  }

  const media = await local.principal().media?.upload({
    channelId: item.channel.id,
    mediaId: 'ea362868-c8cb-492f-87ce-249d1bd3ba52',
    upload: {
      kind: 'file',
      mimeType: 'application/octet-stream',
      fileName: 'large.bin',
      data: new Uint8Array(100 * 1024 * 1024).fill(90)
    }
  })

  if (!media) {
    throw new Error('missing_media')
  }

  const bytes = await local
    .principal()
    .media?.read({ channelId: item.channel.id, mediaId: media.id })

  if (!bytes) {
    throw new Error('missing_media_bytes')
  }

  const input: SendInput = {
    deliveryId: 'large-file',
    channelId: item.channel.id,
    target: item.target,
    chunkIndex: 0,
    signal: new AbortController().signal,
    chunk: { text: '', idempotencyKey: 'large-file:0', state: null, media },
    media: bytes
  }

  expect(await local.plugin.send(input)).toMatchObject({ status: 'pending' })

  const invoke = {
    ...incoming,
    type: 'invoke',
    name: 'fileConsent/invoke',
    value: {
      action: 'accept',
      context: { consentId: 'large-file:0' },
      uploadInfo: {
        uploadUrl: `${local.remote.base}/large-upload`,
        contentUrl: 'https://tenant.sharepoint.com/large.bin',
        uniqueId: 'large-file-id',
        fileType: 'bin'
      }
    }
  }

  expect(
    (await local.core.fetch(await local.incoming({}, invoke))).status
  ).toBe(200)
  let failThirdFragment = true
  local.remote.route(
    '/large-upload',
    (traffic) => {
      const last = Number(
        /-(?<end>\d+)\//u.exec(String(traffic.headers['content-range']))?.[1]
      )

      return last === 104_857_599
        ? { id: 'large-file-id', name: 'large.bin', size: 104_857_600 }
        : {
            expirationDateTime: '2027-01-01T00:00:00Z',
            nextExpectedRanges: [`${String(last + 1)}-`]
          }
    },
    {},
    (traffic) => {
      const range = String(traffic.headers['content-range'])
      if (range === 'bytes 20971520-31457279/104857600' && failThirdFragment) {
        failThirdFragment = false
        return 503
      }
      return range === 'bytes 94371840-104857599/104857600' ? 201 : 202
    }
  )
  expect(await local.plugin.send(input)).toMatchObject({
    status: 'retryable',
    errorCode: 'file_upload_failed'
  })
  await local.close()
  const plugin = createTeamsChannel()

  const restarted = await harness(
    plugin,
    local.config,
    'conversation-1',
    'user-id',
    'root-1',
    filename
  )

  cleanup.push(restarted.close)

  const restored = await restarted
    .principal()
    .media?.read({ channelId: item.channel.id, mediaId: media.id })

  if (!restored) {
    throw new Error('missing_restored_media')
  }
  expect(await plugin.send({ ...input, media: restored })).toMatchObject({
    status: 'sent'
  })

  const uploads = local.remote.traffic.filter(
    (entry) => entry.path === '/large-upload'
  )

  expect(uploads.map((entry) => entry.headers['content-range'])).toEqual([
    'bytes 0-10485759/104857600',
    'bytes 10485760-20971519/104857600',
    'bytes 20971520-31457279/104857600',
    'bytes 20971520-31457279/104857600',
    'bytes 31457280-41943039/104857600',
    'bytes 41943040-52428799/104857600',
    'bytes 52428800-62914559/104857600',
    'bytes 62914560-73400319/104857600',
    'bytes 73400320-83886079/104857600',
    'bytes 83886080-94371839/104857600',
    'bytes 94371840-104857599/104857600'
  ])
  for (const upload of uploads) {
    expect(upload.body).toBe('Z'.repeat(10 * 1024 * 1024))
    expect(upload.headers.authorization).toBeUndefined()
  }

  const sent = local.remote.traffic.filter((entry) =>
    entry.path.includes('/activities')
  )

  expect(sent).toHaveLength(2)
  expect(JSON.parse(sent[1]?.body ?? 'null') as unknown).toMatchObject({
    attachments: [
      {
        contentType: 'application/vnd.microsoft.teams.card.file.info',
        content: { uniqueId: 'large-file-id' }
      }
    ]
  })
})
