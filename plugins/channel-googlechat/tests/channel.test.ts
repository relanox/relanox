import type { CoreRuntime } from '../../../packages/core/src/index.js'
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
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT
} from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createGoogleChatChannel } from '../src/index.js'
import { harness, peer } from './harness.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})
const issuer = 'https://accounts.google.com'
const publicUrl = 'https://relay.example'
const audience = 'https://relay.example/channels/business/webhook'
const caller = 'chat@system.gserviceaccount.com'

const body = JSON.stringify({
  type: 'MESSAGE',
  space: { name: 'spaces/space' },
  message: {
    name: 'spaces/space/messages/msg',
    text: '@Relanox hello',
    argumentText: 'hello',
    sender: { name: 'users/alice', type: 'HUMAN' },
    thread: { name: 'spaces/space/threads/thread' }
  }
})

async function setup(filename = ':memory:'): Promise<{
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
  keys: Awaited<ReturnType<typeof generateKeyPair>>
  config: Readonly<Record<string, Json>>
  plugin: ReturnType<typeof createGoogleChatChannel>
  incoming(
    this: void,
    overrides?: Parameters<
      (overrides?: {
        iss?: string
        aud?: string
        email?: string
        verified?: boolean
        exp?: string
      }) => Promise<string>
    >[0],
    data?: string
  ): Promise<Request>
}> {
  const remote = await peer()
  cleanup.push(remote.close)
  const keys = await generateKeyPair('RS256', { extractable: true })
  const publicKey = await exportJWK(keys.publicKey)
  remote.keys({ keys: [{ ...publicKey, kid: 'google-key' }] })
  vi.stubEnv(
    'CHAT_SERVICE',
    JSON.stringify({
      type: 'service_account',
      client_email: 'relay@example.iam.gserviceaccount.com',
      private_key: await exportPKCS8(keys.privateKey)
    })
  )
  remote.respond(200, { name: 'spaces/space/messages/sent' })

  const config: Json = {
    serviceAccount: { env: 'CHAT_SERVICE' }
  }

  const plugin = createGoogleChatChannel()

  const local = await harness(
    plugin,
    config,
    'spaces/space',
    'users/alice',
    'spaces/space/threads/thread',
    filename,
    publicUrl
  )

  cleanup.push(local.close)

  async function token(
    overrides: {
      iss?: string
      aud?: string
      email?: string
      verified?: boolean
      exp?: string
    } = {}
  ): Promise<string> {
    return new SignJWT({
      email: overrides.email ?? caller,
      email_verified: overrides.verified ?? true
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'google-key' })
      .setIssuer(overrides.iss ?? issuer)
      .setAudience(overrides.aud ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? '5m')
      .sign(keys.privateKey)
  }

  async function incoming(
    overrides?: Parameters<typeof token>[0],
    data = body
  ): Promise<Request> {
    return new Request('http://local/channels/business/webhook', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(overrides)}` },
      body: data
    })
  }

  return { remote, keys, config, plugin, incoming, ...local }
}

describe('native Google Chat', () => {
  it('verifies caller JWT then persists, deduplicates, obtains service-account OAuth and sends to the frozen thread', async () => {
    const local = await setup()
    expect(
      (await local.core.fetch(await local.incoming(undefined, '{'))).status
    ).toBe(400)
    expect((await local.core.fetch(await local.incoming())).status).toBe(200)
    expect((await local.core.fetch(await local.incoming())).status).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(1)

    const completed = await local.sendReply(
      '**answer** [link](https://example.com)'
    )

    expect(completed.delivery?.status).toBe('sent')
    expect(local.dispatches).toEqual(['hello'])

    const oauth = local.remote.traffic.find(
      (request) => request.path === '/token'
    )

    const form = new URLSearchParams(oauth?.body)
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )
    const assertion = form.get('assertion')
    if (!assertion) {
      throw new Error('Missing OAuth assertion')
    }

    const verified = await jwtVerify(assertion, local.keys.publicKey, {
      algorithms: ['RS256'],
      issuer: 'relay@example.iam.gserviceaccount.com',
      audience: 'https://oauth2.googleapis.com/token'
    })

    expect(verified.payload.scope).toBe(
      'https://www.googleapis.com/auth/chat.bot'
    )

    const sent = local.remote.traffic.find((request) =>
      request.path.startsWith('/v1/')
    )

    expect(sent?.path).toBe(
      '/v1/spaces/space/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL'
    )
    expect(sent?.headers.authorization).toBe('Bearer oauth-token')
    expect(JSON.parse(sent?.body ?? 'null') as unknown).toEqual({
      text: '**answer** [link](https://example.com)',
      markupSyntax: 'MARKUP_SYNTAX_MARKDOWN',
      thread: { name: 'spaces/space/threads/thread' }
    })
    expect(completed.request.target.threadId).toBe(
      'spaces/space/threads/thread'
    )
  })

  it.each([
    { aud: 'another-app' },
    { iss: 'https://attacker.example' },
    { email: 'attacker@example.com' },
    { verified: false },
    { exp: '-1s' }
  ])(
    'rejects a cryptographically signed token outside caller trust %j',
    async (overrides) => {
      const local = await setup()
      expect(
        (await local.core.fetch(await local.incoming(overrides))).status
      ).toBe(401)
      expect((await local.storage.getStats()).pending).toBe(0)
    }
  )

  it('rejects invalid signatures and ignores app-authored/non-text events', async () => {
    const local = await setup()
    const foreign = await generateKeyPair('RS256')

    const token = await new SignJWT({ email: caller, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'google-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(foreign.privateKey)

    expect(
      (
        await local.core.fetch(
          new Request('http://local/channels/business/webhook', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body
          })
        )
      ).status
    ).toBe(401)
    const botBody = body.replace('"HUMAN"', '"BOT"')
    expect(
      (await local.core.fetch(await local.incoming(undefined, botBody))).status
    ).toBe(200)
    expect((await local.storage.getStats()).pending).toBe(0)
  })

  it.each(['service account', 'server'])(
    'rejects frozen targets with an obsolete %s scope across SQLite reopen',
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), 'relanox-chat-identity-'))
      cleanup.push(async () => rm(directory, { recursive: true, force: true }))
      const filename = join(directory, 'state.db')
      const local = await setup(filename)
      expect((await local.core.fetch(await local.incoming())).status).toBe(200)
      await local.close()
      const replacement = await peer()
      cleanup.push(replacement.close)
      replacement.token(200, { access_token: 'oauth-token' })
      replacement.respond(200, { name: 'spaces/space/messages/wrong-server' })
      if (change === 'service account') {
        vi.stubEnv(
          'CHAT_SERVICE',
          JSON.stringify({
            type: 'service_account',
            client_email: 'replacement@example.iam.gserviceaccount.com',
            private_key: await exportPKCS8(local.keys.privateKey)
          })
        )
      }

      const config = {
        ...local.config
      }

      const plugin = createGoogleChatChannel()

      const reopened = await harness(
        plugin,
        config,
        'spaces/space',
        'users/alice',
        'spaces/space/threads/thread',
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
        target:
          change === 'server'
            ? {
                ...item.snapshot.target,
                data: {
                  ...z
                    .record(z.string(), z.json())
                    .parse(item.snapshot.target.data),
                  scope: {
                    clientEmail: 'relay@example.iam.gserviceaccount.com',
                    apiBase: 'https://different.example/'
                  }
                }
              }
            : item.snapshot.target,
        chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null }
      }

      expect(await plugin.send(input)).toMatchObject({ status: 'rejected' })
      expect(
        [...local.remote.traffic, ...replacement.traffic].filter((entry) =>
          entry.path.startsWith('/v1/')
        )
      ).toHaveLength(0)
      await reopened.close()
      const rotated = await generateKeyPair('RS256', { extractable: true })
      vi.stubEnv(
        'CHAT_SERVICE',
        JSON.stringify({
          type: 'service_account',
          client_email: 'relay@example.iam.gserviceaccount.com',
          private_key: await exportPKCS8(rotated.privateKey)
        })
      )
      const restoredPlugin = createGoogleChatChannel()

      const restored = await harness(
        restoredPlugin,
        local.config,
        'spaces/space',
        'users/alice',
        'spaces/space/threads/thread',
        filename
      )

      cleanup.push(restored.close)
      const legacy = z.record(z.string(), z.json()).parse(input.target.data)
      delete legacy.scope
      expect(
        await restoredPlugin.send({
          ...input,
          target: { ...input.target, data: legacy }
        })
      ).toMatchObject({ status: 'rejected' })
      expect(
        await restoredPlugin.send({ ...input, target: item.snapshot.target })
      ).toMatchObject({ status: 'sent' })
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
      local.remote.token(status, { error: 'temporarily_unavailable' })
      const completed = await local.sendReply()
      expect(completed.delivery?.status).toBe(expected)
      expect(
        local.remote.traffic.filter((request) =>
          request.path.startsWith('/v1/')
        )
      ).toHaveLength(0)
      if (expected === 'pending') {
        local.remote.token(200, { access_token: 'recovered-token' })
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
            request.path.startsWith('/v1/')
          )
        ).toHaveLength(1)
      }
    }
  )

  it('forwards opaque OAuth tokens longer than entity identifiers intact', async () => {
    const local = await setup()
    const token = `opaque-token-${'a'.repeat(2048)}`
    local.remote.token(200, { access_token: token })
    await local.core.fetch(await local.incoming())
    expect((await local.sendReply()).delivery?.status).toBe('sent')

    const sent = local.remote.traffic.find((request) =>
      request.path.startsWith('/v1/')
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
      local.remote.traffic.filter((request) => request.path.startsWith('/v1/'))
    ).toHaveLength(1)
  })

  it('requires service-account SecretRefs and secure operator endpoints', () => {
    const plugin = createGoogleChatChannel()
    expect(() =>
      plugin.validateConfig({ serviceAccount: 'credentials' })
    ).toThrow()
    expect(() =>
      plugin.validateConfig({
        serviceAccount: { env: 'SERVICE' },
        jwksUrl: 'http://127.0.0.1/keys'
      })
    ).toThrow()
  })
})

it('downloads pure Google Chat media with bot auth and returns a native image card to the frozen thread', async () => {
  const local = await setup()
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 8, 9])
  local.remote.route(
    '/v1/media/spaces/space/messages/media/attachments/file?alt=media',
    bytes,
    {
      'content-type': 'image/png'
    }
  )

  const mediaEvent = {
    type: 'MESSAGE',
    space: { name: 'spaces/space' },
    message: {
      name: 'spaces/space/messages/media',
      sender: { name: 'users/alice', type: 'HUMAN' },
      thread: { name: 'spaces/space/threads/thread' },
      attachment: [
        {
          contentName: 'picture.png',
          contentType: 'image/png',
          attachmentDataRef: {
            resourceName: 'spaces/space/messages/media/attachments/file'
          }
        }
      ]
    }
  }

  expect(
    (
      await local.core.fetch(
        await local.incoming(undefined, JSON.stringify(mediaEvent))
      )
    ).status
  ).toBe(200)
  const scoped = local.principal()
  const item = (await local.storage.listInbound({ limit: 10 }))[0]?.snapshot
  if (!item?.attachments?.[0]) {
    throw new Error('missing_media')
  }
  expect(item.text).toBe('')

  const media = await scoped.media?.read({
    channelId: item.channel.id,
    mediaId: item.attachments[0].id
  })

  if (!media) {
    throw new Error('missing_media_bytes')
  }

  const storageFailure = vi
    .spyOn(local.storage, 'getConversation')
    .mockRejectedValueOnce(new Error('storage_temporarily_unavailable'))

  expect(
    await local.plugin.send({
      deliveryId: 'publication-attempt',
      channelId: item.channel.id,
      target: item.target,
      chunkIndex: 0,
      chunk: {
        text: '',
        state: null,
        idempotencyKey: 'publication:0',
        media: media.reference
      },
      media,
      signal: new AbortController().signal
    })
  ).toMatchObject({
    status: 'retryable',
    errorCode: 'media_preparation_unavailable'
  })
  storageFailure.mockRestore()
  expect(
    local.remote.traffic.filter((request) =>
      request.path.startsWith('/v1/spaces/space/messages')
    )
  ).toHaveLength(0)
  await scoped.sendMessage({
    channel: item.channel.id,
    idempotencyKey: 'media-result',
    text: 'caption',
    attachments: [item.attachments[0].id]
  })
  await local.core.processDue()

  const download = local.remote.traffic.find((request) =>
    request.path.startsWith('/v1/media/')
  )

  expect(download?.headers.authorization).toBe('Bearer oauth-token')

  const sent = local.remote.traffic.filter((request) =>
    request.path.startsWith('/v1/spaces/space/messages')
  )

  expect(sent).toHaveLength(2)
  expect(JSON.parse(sent[0]?.body ?? 'null') as unknown).toEqual({
    text: 'caption',
    markupSyntax: 'MARKUP_SYNTAX_MARKDOWN',
    thread: { name: 'spaces/space/threads/thread' }
  })

  const card = z
    .object({
      cardsV2: z.array(
        z.object({
          card: z.object({
            sections: z.array(
              z.object({
                widgets: z.array(
                  z.object({
                    image: z
                      .object({ imageUrl: z.string(), altText: z.string() })
                      .optional()
                  })
                )
              })
            )
          })
        })
      ),
      thread: z.object({ name: z.string() })
    })
    .parse(JSON.parse(sent[1]?.body ?? 'null'))

  expect(card.thread.name).toBe('spaces/space/threads/thread')
  const image = card.cardsV2[0]?.card.sections[0]?.widgets[0]?.image
  expect(image?.altText).toBe('picture.png')
  if (!image) {
    throw new Error('missing_image_card')
  }
  const published = await local.core.fetch(new Request(image.imageUrl))
  expect(new Uint8Array(await published.arrayBuffer())).toEqual(bytes)
})

it('publishes verified images and preserves text/image/text order in native rich messages', async () => {
  const local = await setup()
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
    request.path.includes('/v1/spaces/space/messages')
  )

  expect(sent).toHaveLength(1)
  expect(JSON.parse(sent[0]?.body ?? 'null') as unknown).toMatchObject({
    cardsV2: [
      {
        card: {
          sections: [
            {
              widgets: [
                { textParagraph: { text: '<b>before</b>' } },
                {
                  image: {
                    altText: 'photo'
                  }
                },
                { textParagraph: { text: 'after' } }
              ]
            }
          ]
        }
      }
    ],
    thread: { name: 'spaces/space/threads/thread' }
  })

  const payload = z
    .object({
      cardsV2: z.array(
        z.object({
          card: z.object({
            sections: z.array(z.object({ widgets: z.array(z.unknown()) }))
          })
        })
      )
    })
    .parse(JSON.parse(sent[0]?.body ?? 'null'))

  const image = z
    .object({ image: z.object({ imageUrl: z.string() }) })
    .parse(payload.cardsV2[0]?.card.sections[0]?.widgets[1])

  expect(image.image.imageUrl).toMatch(/^https:\/\/relay\.example\/media\//u)
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
