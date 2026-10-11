import { expect, it } from 'vitest'
import { incoming, mediaFixture, picture } from './fixture.js'

it('preserves duration and request-owned image previews through upload, completion and send', async () => {
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

    const claim = await scoped.claim(receipt.requestId, 'claim')

    const previewId =
      claim.status === 'claimed'
        ? claim.request.attachments?.[0]?.id
        : undefined

    if (claim.status !== 'claimed' || !previewId || !scoped.media) {
      throw new Error('Expected claim')
    }
    const uploadId = crypto.randomUUID()

    const upload = {
      requestId: receipt.requestId,
      claimToken: claim.claimToken,
      uploadId,
      media: {
        ...picture,
        kind: 'file' as const,
        mimeType: 'application/octet-stream',
        durationMs: 1500,
        previewMediaId: previewId
      }
    }

    expect(await scoped.media.upload(upload)).toMatchObject({
      status: 'stored',
      media: { durationMs: 1500, previewMediaId: previewId }
    })
    await expect(
      scoped.media.upload({
        ...upload,
        uploadId: crypto.randomUUID(),
        media: { ...upload.media, previewMediaId: crypto.randomUUID() }
      })
    ).rejects.toMatchObject({ code: 'invalid_media_preview' })
    await expect(
      scoped.media.upload({
        ...upload,
        uploadId: crypto.randomUUID(),
        media: { ...upload.media, previewMediaId: uploadId }
      })
    ).rejects.toMatchObject({ code: 'invalid_media_preview' })
    expect(
      await scoped.complete({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        resultId: 'final',
        text: '',
        attachments: [uploadId]
      })
    ).toMatchObject({ status: 'completed' })
    await f.runtime.processDue()
    expect(f.sent[0]?.media?.reference).toMatchObject({
      durationMs: 1500,
      previewMediaId: previewId
    })
    expect(f.sent[0]?.preview?.data).toEqual(new Uint8Array([1, 2, 3]))
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
