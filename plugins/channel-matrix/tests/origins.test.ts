import type { ChannelPlugin, Json, SendInput } from '@relanox/sdk'
import { expect, it } from 'vitest'
import { createIrcChannel } from '../../channel-irc/src/index.js'
import { createMattermostChannel } from '../../channel-mattermost/src/index.js'
import { createSignalChannel } from '../../channel-signal/src/index.js'
import { createMatrixChannel } from '../src/index.js'
import { harness, httpPeer, json } from './harness.js'

type OriginCase = {
  readonly name: string
  plugin(): ChannelPlugin<unknown>
  config(base: string): Json
  readonly data: Json
}

const cases: readonly OriginCase[] = [
  {
    name: 'matrix',
    plugin: () => createMatrixChannel({ TOKEN: 'secret' }),
    config: (base) => ({
      homeserver: base,
      accessToken: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    }),
    data: { homeserver: 'https://original.example', userId: '@bot:server' }
  },
  {
    name: 'mattermost',
    plugin: () => createMattermostChannel({ TOKEN: 'secret' }),
    config: (base) => ({
      serverUrl: base,
      token: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    }),
    data: { serverUrl: 'https://original.example', botUserId: 'bot' }
  },
  {
    name: 'signal',
    plugin: () => createSignalChannel(),
    config: (base) => ({
      serviceUrl: base,
      account: '+10000000001',
      allowInsecureLocalhost: true
    }),
    data: {
      kind: 'direct',
      recipient: '+10000000002',
      serviceUrl: 'https://original.example',
      account: '+10000000001'
    }
  },
  {
    name: 'irc',
    plugin: () => createIrcChannel(),
    config: () => ({ server: 'irc.new.example', nick: 'relay' }),
    data: {
      recipient: '#room',
      server: 'irc.original.example',
      port: 6697,
      tls: true
    }
  }
]

it.each(cases)(
  'rejects a frozen $name target when the configured server changes',
  async (example) => {
    let effects = 0

    const peer = await httpPeer((_request, response) => {
      effects += 1
      json(response, {})
    })

    const plugin = example.plugin()
    await harness(
      plugin,
      example.config(peer.base),
      [{ chatId: 'chat' }],
      ['sender'],
      `${peer.base}/dispatch`
    )

    const input: SendInput = {
      deliveryId: 'delivery',
      channelId: 'request',
      target: {
        channel: plugin.channel,
        accountId: 'bot',
        chatId: 'chat',
        data: example.data
      },
      chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
      chunkIndex: 0,
      signal: new AbortController().signal
    }

    expect(await plugin.send(input)).toEqual({
      status: 'rejected',
      errorCode: 'target_mismatch'
    })
    expect(effects).toBe(0)
  }
)

const discoveredCases = cases.filter((example) =>
  ['matrix', 'mattermost'].includes(example.name)
)

it.each(discoveredCases)(
  'binds $name sends to the authenticated identity response',
  async (example) => {
    const discovery: { path: string; authorization: string | undefined }[] = []
    const sends: { path: string; authorization: string | undefined }[] = []
    let effects = 0

    const peer = await httpPeer(
      (request, response) => {
        effects += 1
        if (request.url?.includes('/state/m.room.encryption')) {
          json(response, {}, 404)
          return
        }
        sends.push({
          path: request.url ?? '',
          authorization: request.headers.authorization
        })
        json(
          response,
          example.name === 'matrix' ? { event_id: '$sent' } : { id: 'sent' }
        )
      },
      (request, response) => {
        discovery.push({
          path: request.url ?? '',
          authorization: request.headers.authorization
        })
        json(
          response,
          example.name === 'matrix'
            ? { user_id: '@new:server' }
            : { id: 'new-bot' }
        )
      }
    )

    const plugin = example.plugin()
    await harness(
      plugin,
      example.config(peer.base),
      [{ chatId: 'chat' }],
      ['sender'],
      `${peer.base}/dispatch`
    )
    expect(discovery).toEqual([
      {
        path:
          example.name === 'matrix'
            ? '/_matrix/client/v3/account/whoami'
            : '/api/v4/users/me',
        authorization: 'Bearer secret'
      }
    ])

    const frozen =
      example.name === 'matrix'
        ? { homeserver: peer.base, userId: '@old:server' }
        : { serverUrl: peer.base, botUserId: 'old-bot' }

    const input: SendInput = {
      deliveryId: 'delivery',
      channelId: 'request',
      target: {
        channel: plugin.channel,
        accountId: 'bot',
        chatId: 'chat',
        data: frozen
      },
      chunk: { text: 'answer', idempotencyKey: 'delivery:0', state: null },
      chunkIndex: 0,
      signal: new AbortController().signal
    }

    expect(await plugin.send(input)).toEqual({
      status: 'rejected',
      errorCode: 'target_mismatch'
    })
    expect(effects).toBe(0)

    const discovered =
      example.name === 'matrix'
        ? { homeserver: peer.base, userId: '@new:server' }
        : { serverUrl: peer.base, botUserId: 'new-bot' }

    expect(
      await plugin.send({
        ...input,
        target: { ...input.target, data: discovered }
      })
    ).toMatchObject({ status: 'sent' })
    expect(sends).toEqual([
      {
        path:
          example.name === 'matrix'
            ? '/_matrix/client/v3/rooms/chat/send/m.room.message/delivery%3A0'
            : '/api/v4/posts',
        authorization: 'Bearer secret'
      }
    ])
  }
)

it.each(
  discoveredCases.flatMap((example) =>
    [401, 200].map((status) => ({ example, status }))
  )
)(
  'refuses initialization after $example.name identity discovery returns $status without a valid identity',
  async ({ example, status }) => {
    const peer = await httpPeer(
      (_request, response) => {
        json(response, {})
      },
      (_request, response) => {
        json(response, {}, status)
      }
    )

    const plugin = example.plugin()
    await expect(
      harness(
        plugin,
        example.config(peer.base),
        [{ chatId: 'chat' }],
        ['sender'],
        `${peer.base}/dispatch`
      )
    ).rejects.toThrow()
  }
)
