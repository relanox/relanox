import { afterEach, expect, it, vi } from 'vitest'
import { createLineChannel } from '../src/index.js'
import { peer } from './harness.js'
import { cleanup } from '../../channel-matrix/tests/harness.js'
import { richHost, richInput } from '../../channel-matrix/tests/rich-fixture.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('sends ordered Flex text and images and reuses the stored LINE retry key after recreation', async () => {
  vi.stubEnv('TOKEN', 'secret')
  const remote = await peer()
  cleanup(remote.close)
  remote.respond(200, { sentMessages: [{ id: 'rich' }] })
  const { host, published } = await richHost()

  const account = {
    id: 'account',
    channel: 'line' as const,
    config: null,
    allowedSenders: []
  }

  const config = {
    channelSecret: { env: 'TOKEN' },
    accessToken: { env: 'TOKEN' }
  }

  const plugin = createLineChannel()
  expect(plugin.capabilities.richText).toBeUndefined()
  await plugin.setup(host, account, plugin.validateConfig(config))
  expect(plugin.capabilities.richText).toEqual({
    maxParts: 20,
    maxTextLength: 2000,
    imageMimeTypes: ['image/jpeg', 'image/png'],
    maxImageBytes: 10_000_000
  })

  const input = richInput({
    channel: 'line',
    accountId: 'account',
    chatId: 'group',
    data: { destination: 'group', botId: 'bot', apiBaseUrl: remote.base }
  })

  expect(await plugin.send(input)).toEqual({
    status: 'sent',
    receipt: { platformMessageId: 'rich' }
  })
  expect(JSON.parse(remote.traffic[0]?.body ?? '{}')).toEqual({
    to: 'group',
    messages: [
      {
        type: 'flex',
        altText: 'Before\nChart ] <unsafe>\nAfter',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                wrap: true,
                contents: [{ type: 'span', text: 'Before', weight: 'bold' }]
              },
              {
                type: 'image',
                url: 'https://relay.example/media/87dc7f2b-c7df-4be7-908e-8a85d1e4e707?ticket=bound',
                size: 'full',
                aspectMode: 'fit'
              },
              {
                type: 'text',
                wrap: true,
                contents: [{ type: 'span', text: 'After', style: 'italic' }]
              }
            ]
          }
        }
      }
    ]
  })
  expect(published).toEqual([
    {
      channelId: 'authorized-channel',
      mediaId: '87dc7f2b-c7df-4be7-908e-8a85d1e4e707'
    }
  ])
  const recreated = createLineChannel()
  await recreated.setup(host, account, recreated.validateConfig(config))
  remote.respond(409, {}, { 'x-line-accepted-request-id': 'already-sent' })
  expect(await recreated.send(input)).toEqual({
    status: 'sent',
    receipt: { data: { acceptedRequestId: 'already-sent' } }
  })
  expect(remote.traffic[1]?.headers['x-line-retry-key']).toBe(
    remote.traffic[0]?.headers['x-line-retry-key']
  )
  expect(remote.traffic[0]?.headers['x-line-retry-key']).toMatch(
    /^[a-f\d-]{36}$/u
  )
  expect(await recreated.send({ ...input, richMedia: [] })).toEqual({
    status: 'rejected',
    errorCode: 'missing_media'
  })
  expect(remote.traffic).toHaveLength(2)
  const unavailable = createLineChannel()
  const { host: privateHost } = await richHost(false)
  await unavailable.setup(
    privateHost,
    account,
    unavailable.validateConfig(config)
  )
  expect(unavailable.capabilities.richText).toBeUndefined()
  expect(await unavailable.send(input)).toEqual({
    status: 'rejected',
    errorCode: 'public_media_unavailable'
  })
  expect(remote.traffic).toHaveLength(2)
})
