import { expect, it } from 'vitest'
import { incoming, mediaFixture, picture } from './fixture.js'

it('allows a new generated-file send after retention while replaying only an explicit send intent', async () => {
  const fixture = await mediaFixture()
  try {
    const principal = fixture.agent.forPrincipal({
      subject: 'agent',
      endpointIds: ['first']
    })

    const input = {
      channel: fixture.channelId,
      text: '',
      attachments: [picture],
      idempotencyKey: 'first-send'
    }

    const first = await principal.sendMessage(input)
    expect(await principal.sendMessage(input)).toEqual({
      ...first,
      replay: true
    })
    await fixture.runtime.processDue()
    expect(fixture.sent).toHaveLength(1)
    const firstId = fixture.sent[0]?.media?.reference.id
    if (!firstId) {
      throw new Error('Missing first generated media')
    }
    expect(
      await fixture.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    ).toEqual({ redacted: 1 })
    expect(
      await fixture.storage.media?.get(fixture.channelId, firstId)
    ).toBeUndefined()
    expect(await principal.sendMessage(input)).toEqual({
      ...first,
      replay: true
    })

    const second = await principal.sendMessage({
      ...input,
      idempotencyKey: 'second-send'
    })

    expect(second).toMatchObject({ status: 'queued', replay: false })
    await fixture.runtime.processDue()
    expect(fixture.sent).toHaveLength(2)
    expect(fixture.sent[1]?.media?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(fixture.sent[1]?.media?.reference.id).not.toBe(firstId)
  } finally {
    await fixture.close()
  }
})

it('revokes old agent channel media after rebinding while retaining frozen pending native media', async () => {
  const fixture = await mediaFixture()
  try {
    const receipt = await fixture.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    const asset = (await fixture.storage.getInbound(receipt.requestId))
      ?.snapshot.attachments?.[0]

    const principal = fixture.agent.forPrincipal({
      subject: 'first',
      endpointIds: ['first']
    })

    if (!asset || !principal.media) {
      throw new Error('Missing accepted media')
    }

    const queued = await principal.sendMessage({
      channel: fixture.channelId,
      text: '',
      attachments: [asset.id]
    })

    expect(queued).toMatchObject({ status: 'queued' })

    const changed = {
      ...fixture.runtime.config,
      bindings: [{ accountId: 'bot', chatId: 'chat', endpointId: 'other' }]
    }

    const runtime = await fixture.restart(changed)

    const next = fixture.agent.forPrincipal({
      subject: 'other',
      endpointIds: ['other']
    })

    const previousOwner = fixture.agent.forPrincipal({
      subject: 'first',
      endpointIds: ['first']
    })

    expect(
      await previousOwner.media?.read({
        channelId: fixture.channelId,
        mediaId: asset.id
      })
    ).toBeUndefined()
    expect(
      await next.media?.read({
        channelId: fixture.channelId,
        mediaId: asset.id
      })
    ).toBeUndefined()
    const channel = (await next.status()).channels[0]?.channel.id
    if (!channel || !fixture.channel.media) {
      throw new Error('Missing replacement channel')
    }
    expect(channel).not.toBe(fixture.channelId)
    await expect(
      next.sendMessage({ channel, text: '', attachments: [asset.id] })
    ).rejects.toMatchObject({ code: 'media_not_found' })

    const url = await fixture.channel.media.publish({
      channelId: fixture.channelId,
      mediaId: asset.id
    })

    expect(
      new Uint8Array(
        await (await runtime.fetch(new Request(url))).arrayBuffer()
      )
    ).toEqual(new Uint8Array([1, 2, 3]))
    await runtime.processDue()
    expect(fixture.sent).toMatchObject([
      {
        channelId: fixture.channelId,
        target: { chatId: 'chat' },
        media: { data: new Uint8Array([1, 2, 3]) }
      }
    ])
  } finally {
    await fixture.close()
  }
})

it('keeps channel identity and learned target stable when equivalent endpoint configuration keys are reordered', async () => {
  const fixture = await mediaFixture()
  try {
    const base = {
      ...fixture.runtime.config,
      endpoints: [
        {
          id: 'first',
          agent: 'grok' as const,
          config: { one: 1, two: { x: true, y: 'value' } }
        }
      ]
    }

    await fixture.restart(base)

    const before = fixture.agent.forPrincipal({
      subject: 'first',
      endpointIds: ['first']
    })

    const id = (await before.status()).channels[0]?.channel.id
    if (!id) {
      throw new Error('Missing configured channel')
    }
    await fixture.channel.ingest({ ...incoming, text: 'learn this address' })

    const reordered = {
      ...base,
      endpoints: [
        {
          config: { two: { y: 'value', x: true }, one: 1 },
          agent: 'grok' as const,
          id: 'first'
        }
      ]
    }

    await fixture.restart(reordered)

    const after = fixture.agent.forPrincipal({
      subject: 'first',
      endpointIds: ['first']
    })

    expect((await after.status()).channels[0]?.channel.id).toBe(id)
    expect((await fixture.storage.getConversation(id))?.target?.chatId).toBe(
      'chat'
    )
  } finally {
    await fixture.close()
  }
})
