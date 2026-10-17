import { expect, it } from 'vitest'
import { incoming, mediaFixture, picture } from './fixture.js'

it('preserves duration and generated image previews through atomic enqueue and send', async () => {
  const f = await mediaFixture()
  try {
    const receipt = await f.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    const scoped = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const previewId = (await f.storage.getInbound(receipt.requestId))?.snapshot
      .attachments?.[0]?.id

    if (!previewId) {
      throw new Error('Expected incoming preview')
    }

    const media = {
      ...picture,
      kind: 'file' as const,
      mimeType: 'application/octet-stream',
      durationMs: 1500,
      previewMediaId: previewId
    }

    await expect(
      scoped.sendMessage({
        channel: f.channelId,
        text: '',
        attachments: [{ ...media, previewMediaId: crypto.randomUUID() }]
      })
    ).rejects.toMatchObject({ code: 'invalid_media_preview' })
    expect(
      await scoped.sendMessage({
        channel: f.channelId,
        text: '',
        attachments: [media]
      })
    ).toMatchObject({ status: 'queued' })
    await f.runtime.processDue()
    expect(f.sent[0]?.media?.reference).toMatchObject({
      durationMs: 1500,
      previewMediaId: previewId
    })
    expect(f.sent[0]?.preview?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(
      await scoped.sendMessage({
        channel: f.channelId,
        text: '',
        attachments: [
          {
            media: {
              ...picture,
              kind: 'file',
              mimeType: 'application/octet-stream',
              durationMs: 1500
            },
            preview: {
              ...picture,
              fileName: 'generated.png',
              data: new Uint8Array([4, 5, 6])
            }
          }
        ]
      })
    ).toMatchObject({ status: 'queued' })
    await f.runtime.processDue()
    expect(f.sent[1]?.preview?.data).toEqual(new Uint8Array([4, 5, 6]))
    expect(f.sent[1]?.media?.reference.durationMs).toBe(1500)
  } finally {
    await f.close()
  }
})

it.each([0, -1, 1.5, Infinity, NaN])(
  'rejects invalid media duration %s before persistence',
  async (durationMs) => {
    const f = await mediaFixture()
    try {
      await expect(
        f.channel.ingest({
          ...incoming,
          attachments: [{ ...picture, durationMs }]
        })
      ).rejects.toThrow()
      expect((await f.storage.getStats()).pending).toBe(0)
    } finally {
      await f.close()
    }
  }
)
