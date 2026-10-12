import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { mediaFixture, incoming, picture } from './fixture.js'

it('authorizes staged uploads, preserves immutable retries and sends the returned ID', async () => {
  const f = await mediaFixture()
  try {
    await f.channel.ingest({ ...incoming, text: 'question' })

    const owner = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const foreign = f.agent.forPrincipal({
      subject: 'other',
      endpointIds: ['other']
    })

    if (!owner.media || !foreign.media) {
      throw new Error('Expected agent media host')
    }

    const input = {
      channelId: f.channelId,
      mediaId: randomUUID(),
      upload: picture
    }

    expect(await owner.media.authorize(input)).toBe(true)
    expect(await foreign.media.authorize(input)).toBe(false)
    expect(await foreign.media.upload(input)).toBeUndefined()
    expect(await owner.media.read(input)).toBeUndefined()
    const reference = await owner.media.upload(input)
    expect(reference).toMatchObject({
      id: input.mediaId,
      kind: 'image',
      size: 3
    })
    expect(await owner.media.upload(input)).toEqual(reference)
    await expect(
      owner.media.upload({
        ...input,
        upload: { ...picture, data: new Uint8Array([4]) }
      })
    ).rejects.toMatchObject({ code: 'media_conflict' })
    expect(
      await owner.sendMessage({
        channel: f.channelId,
        text: '',
        attachments: [input.mediaId]
      })
    ).toMatchObject({ status: 'queued' })
    await f.runtime.processDue()
    expect(f.sent[0]?.media?.data).toEqual(picture.data)
    expect(
      await f.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    ).toEqual({ redacted: 2 })
    expect(await owner.media.authorize(input)).toBe(true)
    expect(await owner.media.read(input)).toBeUndefined()
    await expect(owner.media.upload(input)).rejects.toMatchObject({
      code: 'media_conflict'
    })
  } finally {
    await f.close()
  }
})

it('persists incoming bytes and sends replayable ordered replies without a claim', async () => {
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

    expect(
      await f.channel.ingest({ ...incoming, attachments: [picture] })
    ).toEqual({ requestId: receipt.requestId, duplicate: true })

    const scoped = f.agent.forPrincipal({
      subject: 'worker',
      endpointIds: ['first']
    })

    const ref = (await f.storage.getInbound(receipt.requestId))?.snapshot
      .attachments?.[0]

    if (!ref || !scoped.media) {
      throw new Error('Expected inbound media')
    }
    expect(ref).toMatchObject({
      kind: 'image',
      size: 3,
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
    })
    const args = { channelId: f.channelId, mediaId: ref.id }
    expect((await scoped.media.read(args))?.data).toEqual(
      new Uint8Array([1, 2, 3])
    )

    const other = f.agent.forPrincipal({
      subject: 'other',
      endpointIds: ['other']
    })

    expect(await other.media?.read(args)).toBeUndefined()
    expect(
      await other.sendMessage({
        channel: f.channelId,
        text: 'unauthorized'
      })
    ).toEqual({ status: 'not_found' })

    const generated = {
      kind: 'file' as const,
      mimeType: 'application/octet-stream',
      fileName: 'result.bin',
      data: new Uint8Array([4, 5])
    }

    const input = {
      channel: f.channelId,
      idempotencyKey: 'answer',
      text: 'abcdef',
      attachments: [generated, ref.id]
    }

    const first = await scoped.sendMessage(input)
    expect(first).toMatchObject({ status: 'queued', replay: false })
    expect(await scoped.sendMessage(input)).toEqual({ ...first, replay: true })
    expect(
      await scoped.sendMessage({ ...input, attachments: [ref.id, generated] })
    ).toEqual({ status: 'conflict' })
    await f.runtime.processDue()
    expect(f.sent.map((item) => item.chunk.text)).toEqual([
      'abc',
      'def',
      '',
      ''
    ])
    expect(f.sent[2]?.media?.data).toEqual(new Uint8Array([4, 5]))
    expect(f.sent[3]?.media?.reference.id).toBe(ref.id)
    const followup = { channel: f.channelId, text: 'ok' }
    expect(await scoped.sendMessage(followup)).toMatchObject({
      status: 'queued',
      replay: false
    })
    expect(await scoped.sendMessage(followup)).toMatchObject({
      status: 'queued',
      replay: false
    })
    await f.runtime.processDue()
    expect(f.sent.map((item) => item.chunk.text)).toEqual([
      'abc',
      'def',
      '',
      '',
      'ok',
      'ok'
    ])
    expect(await f.storage.listOutbound({ limit: 10 })).toHaveLength(3)
  } finally {
    await f.close()
  }
})

it('retains endpoint media access after notification redispatch and removes expired bytes after redaction', async () => {
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

    await f.runtime.processDue()
    const request = await f.storage.getInbound(receipt.requestId)
    const id = request?.snapshot.attachments?.[0]?.id
    if (!request || !id || !scoped.media) {
      throw new Error('Expected incoming media')
    }
    expect(
      await f.runtime.requeue({
        kind: 'request',
        id: receipt.requestId,
        expectedVersion: request.version,
        acknowledgeUnknown: false
      })
    ).toMatchObject({ status: 'updated' })
    const input = { channelId: f.channelId, mediaId: id }
    expect((await scoped.media.read(input))?.data).toEqual(picture.data)
    await scoped.sendMessage({ channel: f.channelId, text: 'ok' })
    await f.runtime.processDue()
    expect(
      await f.storage.cleanup({ before: Date.now() + 1000, limit: 10 })
    ).toEqual({ redacted: 2 })
    expect(await scoped.media.read(input)).toBeUndefined()
    expect(
      await scoped.sendMessage({ channel: f.channelId, text: 'late' })
    ).toMatchObject({ status: 'queued', replay: false })
  } finally {
    await f.close()
  }
})

it('rejects malformed or oversized media and unsupported sends without enqueueing', async () => {
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

    const request = await f.storage.getInbound(receipt.requestId)
    const ref = request?.snapshot.attachments?.[0]
    if (!ref) {
      throw new Error('Expected media')
    }
    await expect(
      scoped.sendMessage({
        channel: f.channelId,
        idempotencyKey: 'final',
        text: '',
        attachments: [ref.id]
      })
    ).rejects.toMatchObject({ code: 'media_not_supported' })
    expect(await f.storage.listOutbound({ limit: 10 })).toEqual([])
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
        pull(): void {
          reads++
        },
        cancel(): void {
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

    const request = (path: string, length: number): Request =>
      new Request(`http://localhost/agents/grok/${path}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer test' },
        body: new Uint8Array(length)
      })

    expect((await f.runtime.fetch(request('media/asset', 16))).status).toBe(200)
    expect((await f.runtime.fetch(request('media/asset', 17))).status).toBe(413)
    expect((await f.runtime.fetch(request('json', 2_097_153))).status).toBe(413)
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

      const request = await f.storage.getInbound(receipt.requestId)
      const ref = request?.snapshot.attachments?.[0]
      if (!ref) {
        throw new Error('Expected media')
      }
      const id = ref.id
      expect(
        await scoped.sendMessage({
          channel: f.channelId,
          idempotencyKey: 'final',
          text: '',
          attachments: [id]
        })
      ).toMatchObject({ status: 'queued' })
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
  'applies outgoing media %s budgets per send, allowing later sends on the same channel',
  async (budget) => {
    const f = await mediaFixture()
    try {
      const scoped = f.agent.forPrincipal({
        subject: 'worker',
        endpointIds: ['first']
      })

      const size = budget === 'count' ? 3 : 16

      const attachment = {
        kind: 'file' as const,
        mimeType: 'application/octet-stream',
        fileName: 'asset.bin',
        data: new Uint8Array(size)
      }

      for (let index = 0; index < 5; index++) {
        expect(
          await scoped.sendMessage({
            channel: f.channelId,
            text: '',
            idempotencyKey: `send-${index}`,
            attachments: [attachment]
          })
        ).toMatchObject({ status: 'queued', replay: false })
      }

      const tooLarge =
        budget === 'count'
          ? [attachment, attachment, attachment]
          : [attachment, { ...attachment, fileName: 'second.bin' }]

      await expect(
        scoped.sendMessage({
          channel: f.channelId,
          text: '',
          attachments: tooLarge
        })
      ).rejects.toMatchObject({
        code:
          budget === 'count' ? 'too_many_attachments' : 'media_total_too_large'
      })
      expect(
        await scoped.sendMessage({
          channel: f.channelId,
          text: '',
          idempotencyKey: 'send-0',
          attachments: [attachment]
        })
      ).toMatchObject({ status: 'queued', replay: true })
      expect(await f.storage.listOutbound({ limit: 10 })).toHaveLength(5)
    } finally {
      await f.close()
    }
  }
)
