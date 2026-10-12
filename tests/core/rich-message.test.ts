import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { mediaFixture, picture } from './fixture.js'

it.each([{ maxImageBytes: 1 }, { imageMimeTypes: ['image/jpeg'] }])(
  'falls back to ordered native media when a rich image exceeds %j',
  async (restriction) => {
    const f = await mediaFixture(
      ['image'],
      'https://relay.example',
      undefined,
      { maxParts: 3, maxTextLength: 3, ...restriction }
    )

    try {
      const principal = f.agent.forPrincipal({
        subject: 'worker',
        endpointIds: ['first']
      })

      expect(
        await principal.sendMessage({
          channel: f.channelId,
          text: 'A![image](relanox://attachment/1)B',
          attachments: [picture]
        })
      ).toMatchObject({ status: 'queued' })
      await f.runtime.processDue()
      expect(
        f.sent.map((item) =>
          item.media ? [...item.media.data] : item.chunk.text
        )
      ).toEqual(['A', [1, 2, 3], 'B'])
      expect(f.sent.every((item) => item.chunk.richText === undefined)).toBe(
        true
      )
    } finally {
      await f.close()
    }
  }
)

// Existing media tests cover text followed by attachments, not Markdown positions or native groups.
// These tests exercise public Agent/Channel hosts and real SQLite recovery without new production seams.
it('persists Markdown reading order across restart and replays the same rich send after cleanup', async () => {
  const f = await mediaFixture()
  try {
    const principal = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const input = {
      channel: f.channelId,
      idempotencyKey: 'ordered-rich',
      text: 'A![second](relanox://attachment/2)B![first](relanox://attachment/1)C',
      attachments: [picture, { ...picture, data: new Uint8Array([4, 5]) }]
    }

    const receipt = await principal.sendMessage(input)
    expect(receipt).toMatchObject({ status: 'queued', replay: false })
    const runtime = await f.restart()
    await runtime.processDue()
    expect(
      f.sent.map((sent) =>
        sent.media ? [...sent.media.data] : sent.chunk.text
      )
    ).toEqual(['A', [4, 5], 'B', [1, 2, 3], 'C'])
    await f.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    expect(
      await f.agent
        .forPrincipal({ subject: 'worker', endpointIds: ['first'] })
        .sendMessage(input)
    ).toEqual({ ...receipt, replay: true })
    await runtime.processDue()
    expect(f.sent).toHaveLength(5)
  } finally {
    await f.close()
  }
})

it('groups native images with surrounding text within part limits and resolves bytes after restart', async () => {
  const f = await mediaFixture(['image'], 'https://relay.example', undefined, {
    maxParts: 3,
    maxTextLength: 3
  })

  try {
    const principal = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    expect((await principal.status()).channels[0]?.richText).toBe('native')
    expect(
      await principal.sendMessage({
        channel: f.channelId,
        text: 'A![one](relanox://attachment/1)B![two](relanox://attachment/2)C',
        attachments: [picture, { ...picture, data: new Uint8Array([9]) }]
      })
    ).toMatchObject({ status: 'queued' })
    await f.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    const runtime = await f.restart()
    await runtime.processDue()
    expect(
      f.sent.map((item) =>
        item.chunk.richText?.map((part) =>
          part.type === 'text' ? part.text : part.label
        )
      )
    ).toEqual([
      ['A', 'one', 'B'],
      ['two', 'C']
    ])
    expect(
      f.sent.map((item) => item.richMedia?.map((media) => [...media.data]))
    ).toEqual([[[1, 2, 3]], [[9]]])
    expect(f.sent.map((item) => item.chunkIndex)).toEqual([0, 1])
  } finally {
    await f.close()
  }
})

it('rejects invalid references and wrong image kinds before any message is queued', async () => {
  const f = await mediaFixture()
  try {
    const principal = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    for (const text of [
      '![missing](relanox://attachment/2)',
      '![bad](relanox://attachment/0)',
      '![repeat](relanox://attachment/1)![again](relanox://attachment/1)'
    ]) {
      await expect(
        principal.sendMessage({
          channel: f.channelId,
          text,
          attachments: [picture]
        })
      ).rejects.toThrow()
    }
    await expect(
      principal.sendMessage({
        channel: f.channelId,
        text: '![wrong](relanox://attachment/1)',
        attachments: [
          { ...picture, kind: 'file', mimeType: 'application/octet-stream' }
        ]
      })
    ).rejects.toMatchObject({ code: 'invalid_image_reference' })
    expect(await f.storage.listOutbound({ limit: 10 })).toEqual([])
    expect(f.sent).toEqual([])
  } finally {
    await f.close()
  }
})

it('resolves media URIs only inside their owning channel, including when the Agent owns both chats', async () => {
  const f = await mediaFixture()
  try {
    const runtime = await f.restart({
      ...f.runtime.config,
      bindings: [
        ...f.runtime.config.bindings,
        { accountId: 'bot', chatId: 'second-chat', endpointId: 'first' }
      ]
    })

    const principal = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const second = (await principal.status()).channels.find(
      (item) => item.channel.chatId === 'second-chat'
    )

    if (!second || !principal.media) {
      throw new Error('Expected second authorized channel')
    }
    const id = randomUUID()
    expect(
      await principal.media.upload({
        channelId: second.channel.id,
        mediaId: id,
        upload: picture
      })
    ).toMatchObject({ id })
    await expect(
      principal.sendMessage({
        channel: f.channelId,
        text: `![foreign](relanox://media/${id})`
      })
    ).rejects.toMatchObject({ code: 'media_not_found' })
    expect(
      await principal.sendMessage({
        channel: second.channel.id,
        text: `![own](relanox://media/${id})`
      })
    ).toMatchObject({ status: 'queued' })
    await runtime.processDue()
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.media?.data).toEqual(new Uint8Array([1, 2, 3]))
  } finally {
    await f.close()
  }
})
