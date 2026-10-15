import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { expect, it } from 'vitest'
import { createMattermostChannel } from '../src/index.js'
import { assemble, peer } from '../../channel-wecom/tests/test-support.js'

installPeerNetwork()

const botId = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

const chatId = 'cccccccccccccccccccccccccc'

const postIds = [
  'ppppppppppppppppppppppppp1',
  'ppppppppppppppppppppppppp2',
  'ppppppppppppppppppppppppp3'
]

// Native Post and create-post root_id are documented by Mattermost:
// https://docs.mattermost.com/api/reference/create-post
it('threads out-of-order replies to selected incoming posts and sends ordinary posts without root_id', async () => {
  const remote = await peer(
    (request) => ({
      body: {
        id:
          request.path === '/api/v4/users/me'
            ? botId
            : 'ssssssssssssssssssssssssss'
      }
    }),
    (socket) => {
      socket.once('message', () => {
        socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
        for (const [index, id] of postIds.entries()) {
          socket.send(
            JSON.stringify({
              event: 'posted',
              seq: index + 1,
              data: {
                post: JSON.stringify({
                  id,
                  user_id: userId,
                  channel_id: chatId,
                  message: id,
                  root_id: '',
                  create_at: 1_800_000_000_000,
                  type: ''
                })
              }
            })
          )
        }
      })
    }
  )

  const plugin = createMattermostChannel({ TOKEN: 'bot-token' })

  const local = await assemble(
    plugin,
    { serverUrl: remote.http, token: { env: 'TOKEN' } },
    [{ chatId, senderId: userId }]
  )

  await local.start()
  await expect.poll(() => remote.sockets.length).toBe(1)
  await expect.poll(() => remote.frames.length).toBe(1)
  await expect
    .poll(async () => local.storage.listInbound({ limit: 10 }))
    .toHaveLength(3)
  const incoming = await local.storage.listInbound({ limit: 10 })
  const principal = local.principal()
  for (const id of [postIds[1], postIds[0], postIds[2]]) {
    const request = incoming.find((item) => item.snapshot.text === id)?.snapshot
    if (!request) {
      throw new Error('missing_incoming_post')
    }
    expect(
      await principal.sendMessage({
        channel: request.channel.id,
        text: `answer ${id}`,
        reply: { requestId: request.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await local.runtime.processDue()
  }
  const channel = incoming[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await principal.sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await local.runtime.processDue()

  const posts = remote.requests.filter(
    (request) => request.path === '/api/v4/posts'
  )

  expect(posts.map((request) => request.body)).toEqual([
    {
      channel_id: chatId,
      message: 'answer ppppppppppppppppppppppppp2',
      root_id: 'ppppppppppppppppppppppppp2'
    },
    {
      channel_id: chatId,
      message: 'answer ppppppppppppppppppppppppp1',
      root_id: 'ppppppppppppppppppppppppp1'
    },
    {
      channel_id: chatId,
      message: 'answer ppppppppppppppppppppppppp3',
      root_id: 'ppppppppppppppppppppppppp3'
    },
    { channel_id: chatId, message: 'ordinary' }
  ])
})
