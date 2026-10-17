import { expect, it } from 'vitest'
import { z } from 'zod'
import { assemble, records } from '../../channel-wecom/tests/test-support.js'
import { cleanup, waitFor } from '../../channel-matrix/tests/harness.js'
import {
  installPeerNetwork,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { peer } from './peer.js'
import { discordPeer } from './media-peer.js'
import { createDiscordChannel } from '../src/index.js'

installPeerNetwork()

// Native message/create and message_reference contracts:
// https://docs.discord.com/developers/events/gateway-events#message-create
// https://docs.discord.com/developers/resources/message#create-message
// Protects request selection across Core resolution, which direct send tests skip.
// Losing the persisted message ID or quoting latest input fails the wire assertions.
// Uses production AgentHost and SQLite, adding no production testing seam.
it('quotes three selected Gateway requests out of order and sends ordinary text unquoted', async () => {
  const remote = await peer(() => ({ body: { id: '900' } }))
  cleanup(remote.close)
  const gateway = await discordPeer()
  cleanup(gateway.close)
  routePlatform('wss://gateway.discord.gg', gateway.url)
  const plugin = createDiscordChannel({ TOKEN: 'token' })

  const fixture = await assemble(plugin, { botToken: { env: 'TOKEN' } }, [
    { chatId: '456', senderId: '42' }
  ])

  await fixture.start()
  await waitFor(() =>
    gateway.frames.some(
      (frame) => z.object({ op: z.number() }).parse(frame).op === 2
    )
  )
  for (const [index, id] of ['11', '22', '33'].entries()) {
    gateway.message(
      {
        id,
        channel_id: '456',
        type: 0,
        author: { id: '42' },
        content: `question ${id}`
      },
      index + 2
    )
  }
  await waitFor(async () => (await records(fixture.storage)).length === 3)
  const received = await records(fixture.storage)
  for (const id of ['22', '11', '33']) {
    const request = received.find(
      (item) => item.snapshot.target.replyToId === id
    )

    if (!request) {
      throw new Error('missing_request')
    }
    expect(
      await fixture.principal().sendMessage({
        channel: request.snapshot.channel.id,
        text: `answer ${id}`,
        reply: { requestId: request.snapshot.requestId, kind: 'final' }
      })
    ).toMatchObject({ status: 'queued' })
    await fixture.runtime.processDue()
  }
  const channel = received[0]?.snapshot.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }
  expect(
    await fixture.principal().sendMessage({ channel, text: 'ordinary' })
  ).toMatchObject({ status: 'queued' })
  await fixture.runtime.processDue()

  const messages = remote.requests.map((request) =>
    z
      .object({
        content: z.string(),
        message_reference: z.object({ message_id: z.string() }).optional()
      })
      .parse(request.body)
  )

  expect(messages).toEqual([
    { content: 'answer 22', message_reference: { message_id: '22' } },
    { content: 'answer 11', message_reference: { message_id: '11' } },
    { content: 'answer 33', message_reference: { message_id: '33' } },
    { content: 'ordinary' }
  ])
})
