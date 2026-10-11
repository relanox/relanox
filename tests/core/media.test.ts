import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { mediaFixture, incoming, picture } from './fixture.js'

it('persists pure media, fences claim scope and sends ordered media after text', async () => {
  const f = await mediaFixture()
  try {
    await expect(
      f.channel.ingest({
        ...incoming,
        senderId: 'mallory',
        attachments: [picture]
      })
    ).rejects.toMatchObject({ code: 'sender_not_allowed' })
    expect((await f.storage.getStats()).pending).toBe(0)

    const receipt = await f.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    const duplicate = await f.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    expect(duplicate).toEqual({ requestId: receipt.requestId, duplicate: true })

    const scoped = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const claim = await scoped.claim(receipt.requestId, 'claim')
    if (claim.status !== 'claimed' || !scoped.media) {
      throw new Error('Expected media claim')
    }
    const ref = claim.request.attachments?.[0]
    if (!ref) {
      throw new Error('Expected inbound media')
    }
    expect(ref).toMatchObject({
      kind: 'image',
      size: 3,
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
    })

    const args = {
      requestId: receipt.requestId,
      claimToken: claim.claimToken,
      mediaId: ref.id
    }

    expect((await scoped.media.read(args))?.data).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(
      await f.agent
        .forPrincipal({ subject: 'other', endpointIds: ['other'] })
        .media?.read(args)
    ).toBeUndefined()
    const uploadId = crypto.randomUUID()

    const upload = {
      requestId: receipt.requestId,
      claimToken: claim.claimToken,
      uploadId,
      media: {
        kind: 'file' as const,
        mimeType: 'application/octet-stream',
        fileName: 'result.bin',
        data: new Uint8Array([4, 5])
      }
    }

    expect(await scoped.media.upload(upload)).toMatchObject({
      status: 'stored',
      replay: false
    })
    expect(await scoped.media.upload(upload)).toMatchObject({
      status: 'stored',
      replay: true
    })
    expect(
      await scoped.media.upload({
        ...upload,
        media: { ...upload.media, data: new Uint8Array([9]) }
      })
    ).toEqual({ status: 'conflict' })

    const result = {
      requestId: receipt.requestId,
      claimToken: claim.claimToken,
      resultId: 'final',
      text: 'abcdef',
      attachments: [uploadId, ref.id]
    }

    expect(await scoped.complete(result)).toMatchObject({
      status: 'completed',
      replay: false
    })
    expect(await scoped.complete(result)).toMatchObject({
      status: 'completed',
      replay: true
    })
    expect(
      await scoped.complete({ ...result, attachments: [ref.id, uploadId] })
    ).toEqual({
      status: 'conflict'
    })
    await f.runtime.processDue()
    expect(f.sent.map((input) => input.chunk.text)).toEqual([
      'abc',
      'def',
      '',
      ''
    ])
    expect(f.sent.map((input) => input.media?.reference.id)).toEqual([
      undefined,
      undefined,
      uploadId,
      ref.id
    ])
    expect(f.sent[2]?.media?.data).toEqual(new Uint8Array([4, 5]))
    expect((await f.storage.listOutbound({ limit: 10 }))[0]?.status).toBe(
      'sent'
    )
  } finally {
    await f.close()
  }
})

it('revokes media read and upload access after requeue', async () => {
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

    const claim = await scoped.claim(receipt.requestId, 'old')
    if (
      claim.status !== 'claimed' ||
      !scoped.media ||
      !claim.request.attachments?.[0]
    ) {
      throw new Error('Expected claim')
    }
    const request = await f.storage.getInbound(receipt.requestId)
    if (!request) {
      throw new Error('Expected request')
    }
    expect(
      await f.runtime.requeue({
        kind: 'request',
        id: receipt.requestId,
        expectedVersion: request.version,
        acknowledgeUnknown: false
      })
    ).toMatchObject({ status: 'updated' })
    expect(
      await scoped.media.read({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        mediaId: claim.request.attachments[0].id
      })
    ).toBeUndefined()
    expect(
      await scoped.media.upload({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        uploadId: crypto.randomUUID(),
        media: picture
      })
    ).toEqual({ status: 'unauthorized' })
    expect(
      await scoped.complete({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        resultId: 'stale',
        text: '',
        attachments: [claim.request.attachments[0].id]
      })
    ).toEqual({ status: 'unauthorized' })
  } finally {
    await f.close()
  }
})

it('rejects malformed or oversized media and unsupported sends without completing', async () => {
  const f = await mediaFixture([])
  try {
    await expect(
      f.channel.ingest({
        ...incoming,
        attachments: [{ ...picture, fileName: '../picture.png' }]
      })
    ).rejects.toThrow()
    await expect(
      f.channel.ingest({
        ...incoming,
        attachments: [{ ...picture, mimeType: 'text/plain' }]
      })
    ).rejects.toMatchObject({ code: 'invalid_media_type' })
    await expect(
      f.channel.ingest({
        ...incoming,
        attachments: [{ ...picture, data: new Uint8Array(17) }]
      })
    ).rejects.toMatchObject({ code: 'media_too_large' })
    await expect(
      f.channel.ingest({
        ...incoming,
        attachments: [picture, picture, picture]
      })
    ).rejects.toMatchObject({ code: 'too_many_attachments' })
    await expect(
      f.channel.ingest({
        ...incoming,
        attachments: [
          { ...picture, data: new Uint8Array(13) },
          { ...picture, data: new Uint8Array(13) }
        ]
      })
    ).rejects.toMatchObject({ code: 'media_total_too_large' })

    const receipt = await f.channel.ingest({
      ...incoming,
      attachments: [picture]
    })

    const scoped = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const claim = await scoped.claim(receipt.requestId, 'claim')
    if (claim.status !== 'claimed' || !claim.request.attachments?.[0]) {
      throw new Error('Expected claim')
    }
    await expect(
      scoped.complete({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        resultId: 'final',
        text: '',
        attachments: [claim.request.attachments[0].id]
      })
    ).rejects.toMatchObject({ code: 'media_not_supported' })
    expect((await f.storage.getInbound(receipt.requestId))?.status).toBe(
      'claimed'
    )
    expect(f.sent).toHaveLength(0)
  } finally {
    await f.close()
  }
})

it('authenticates media routes before reading and preserves ordinary body limits', async () => {
  const f = await mediaFixture()
  try {
    let reads = 0
    let cancelled = false

    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads++
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )

    const denied = await f.runtime.fetch(
      new Request('http://localhost/agents/grok/media/asset', {
        method: 'PUT',
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
    )

    expect(denied.status).toBe(401)
    expect(reads).toBe(0)
    expect(cancelled).toBe(true)

    const request = (path: string, length: number) =>
      new Request(`http://localhost/agents/grok/${path}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test' },
        body: new Uint8Array(length)
      })

    expect((await f.runtime.fetch(request('media/asset', 16))).status).toBe(200)
    expect((await f.runtime.fetch(request('media/asset', 17))).status).toBe(413)
    expect((await f.runtime.fetch(request('json', 9))).status).toBe(413)
  } finally {
    await f.close()
  }
})

it.each(['missing', 'corrupt'])(
  'stops sending when durable media bytes become %s',
  async (condition) => {
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
      if (claim.status !== 'claimed' || !claim.request.attachments?.[0]) {
        throw new Error('Expected claim')
      }
      const id = claim.request.attachments[0].id
      expect(
        await scoped.complete({
          requestId: receipt.requestId,
          claimToken: claim.claimToken,
          resultId: 'final',
          text: '',
          attachments: [id]
        })
      ).toMatchObject({ status: 'completed' })
      const database = new DatabaseSync(f.filename)
      try {
        database
          .prepare('UPDATE media SET data=? WHERE id=?')
          .run(condition === 'missing' ? null : new Uint8Array([9, 9, 9]), id)
      } finally {
        database.close()
      }
      await f.runtime.processDue()
      expect(f.sent).toHaveLength(0)
      const record = (await f.storage.listOutbound({ limit: 10 }))[0]
      expect(record).toMatchObject({
        status: 'rejected',
        errorCode:
          condition === 'missing' ? 'media_not_found' : 'media_integrity_error'
      })
    } finally {
      await f.close()
    }
  }
)

it.each(['count', 'bytes'])(
  'passes atomic staged media %s budgets through the agent host',
  async (budget) => {
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
      if (claim.status !== 'claimed' || !scoped.media) {
        throw new Error('Expected media claim')
      }
      const accepted = budget === 'count' ? 3 : 2
      const size = budget === 'count' ? 3 : 16

      const upload = (uploadId: string) => ({
        requestId: receipt.requestId,
        claimToken: claim.claimToken,
        uploadId,
        media: {
          kind: 'file' as const,
          mimeType: 'application/octet-stream',
          fileName: 'asset.bin',
          data: new Uint8Array(size)
        }
      })

      const firstId = crypto.randomUUID()
      expect(await scoped.media.upload(upload(firstId))).toMatchObject({
        status: 'stored',
        replay: false
      })
      for (let index = 1; index < accepted; index++) {
        expect(
          await scoped.media.upload(upload(crypto.randomUUID()))
        ).toMatchObject({
          status: 'stored',
          replay: false
        })
      }
      expect(await scoped.media.upload(upload(crypto.randomUUID()))).toEqual({
        status: 'conflict'
      })
      expect(await scoped.media.upload(upload(firstId))).toMatchObject({
        status: 'stored',
        replay: true
      })
    } finally {
      await f.close()
    }
  }
)
