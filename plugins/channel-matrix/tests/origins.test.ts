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
      userId: '@bot:server',
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
      botUserId: 'bot',
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
      requestId: 'request',
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
