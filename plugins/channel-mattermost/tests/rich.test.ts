import { expect, it } from 'vitest'
import { createMattermostChannel } from '../src/index.js'
import { body, httpPeer, json } from '../../channel-matrix/tests/harness.js'
import { richHost, richInput } from '../../channel-matrix/tests/rich-fixture.js'

it('publishes scoped inline images in one ordered Mattermost Markdown post', async () => {
  const sent: { authorization: string | undefined; content: unknown }[] = []

  const remote = await httpPeer(async (request, response) => {
    sent.push({
      authorization: request.headers.authorization,
      content: await body(request)
    })
    json(response, { id: 'rich' })
  })

  const plugin = createMattermostChannel({ TOKEN: 'secret' })
  const { host, published } = await richHost()
  expect(plugin.capabilities.richText).toBeUndefined()
  await plugin.setup(
    host,
    { id: 'account', channel: 'mattermost', config: null, allowedSenders: [] },
    plugin.validateConfig({
      serverUrl: remote.base,
      token: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    })
  )
  expect(plugin.capabilities.richText).toEqual({
    maxParts: 20,
    maxTextLength: 8000
  })

  const input = richInput({
    channel: 'mattermost',
    accountId: 'account',
    chatId: 'channel',
    threadId: 'thread',
    data: { serverUrl: remote.base, botUserId: 'self-bot' }
  })

  expect(await plugin.send(input)).toEqual({
    status: 'sent',
    receipt: { platformMessageId: 'rich' }
  })
  expect(sent).toEqual([
    {
      authorization: 'Bearer secret',
      content: {
        channel_id: 'channel',
        root_id: 'thread',
        message:
          '**Before**\n\n![Chart \\] <unsafe>](<https://relay.example/media/87dc7f2b-c7df-4be7-908e-8a85d1e4e707?ticket=bound>)\n\n*After*'
      }
    }
  ])
  expect(published).toEqual([
    {
      channelId: 'authorized-channel',
      mediaId: '87dc7f2b-c7df-4be7-908e-8a85d1e4e707'
    }
  ])
  expect(
    await plugin.send({
      ...input,
      chunk: {
        ...input.chunk,
        richText: [{ type: 'text', text: 'x'.repeat(8001) }]
      },
      richMedia: []
    })
  ).toEqual({ status: 'rejected', errorCode: 'rich_message_limit_exceeded' })
  expect(sent).toHaveLength(1)
  expect(published).toHaveLength(1)
  const unavailable = createMattermostChannel({ TOKEN: 'secret' })
  const { host: privateHost } = await richHost(false)
  await unavailable.setup(
    privateHost,
    { id: 'account', channel: 'mattermost', config: null, allowedSenders: [] },
    unavailable.validateConfig({
      serverUrl: remote.base,
      token: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    })
  )
  expect(unavailable.capabilities.richText).toBeUndefined()
  expect(await unavailable.send(input)).toEqual({
    status: 'rejected',
    errorCode: 'public_media_unavailable'
  })
  expect(sent).toHaveLength(1)
})
