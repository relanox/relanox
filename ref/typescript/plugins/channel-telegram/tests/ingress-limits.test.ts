import { afterEach, expect, it, vi } from 'vitest'
import { ingressFixture, webhook } from './ingress-fixture.js'
import { mediaPeer } from './media-peer.js'
import type { MediaReply } from './media-peer.js'

function limitedFileReply(stage: string, method: string): MediaReply {
  // Client.cpp do_get_file/on_update_file emits this exact native 400 error
  // When the cloud Bot API's 20 MiB download limit is exceeded.
  if (stage === 'Bot API download limit') {
    return {
      status: 400,
      json: {
        ok: false,
        error_code: 400,
        description: 'Bad Request: file is too big'
      }
    }
  }
  if (method === 'GET') {
    return { data: Uint8Array.of(1, 2, 3, 4, 5), mimeType: 'application/pdf' }
  }
  return {
    json: {
      ok: true,
      result: {
        file_id: 'native-document',
        file_unique_id: 'document-unique',
        file_path: 'documents/file_1.pdf',
        ...(stage === 'getFile size' ? { file_size: 5 } : {})
      }
    }
  }
}

const limitStages = [
  { stage: 'message size', paths: [] },
  { stage: 'getFile size', paths: ['/bot123:abc/getFile'] },
  { stage: 'Bot API download limit', paths: ['/bot123:abc/getFile'] },
  {
    stage: 'download bytes',
    paths: ['/bot123:abc/getFile', '/file/bot123:abc/documents/file_1.pdf']
  },
  {
    stage: 'total bytes',
    paths: ['/bot123:abc/getFile', '/file/bot123:abc/documents/file_1.pdf']
  }
]

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Telegram-bot-api e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1:
// Client.cpp add_message_update uses chat_id as webhook queue ID;
// WebhookActor.cpp on_update_error retains the head, drop_event advances it,
// And handle accepts all HTTP 2xx as success. A permanent refusal must ACK.
it.each(limitStages)(
  'acknowledges a permanent $stage refusal and durably accepts later text',
  async ({ stage, paths }) => {
    const remote = await mediaPeer((traffic) =>
      limitedFileReply(stage, traffic.method)
    )

    cleanups.push(remote.close)

    const fixture = await ingressFixture(cleanups, remote.origin, {
      maxMediaBytes: stage === 'total bytes' ? 8 : 4,
      maxTotalMediaBytes: stage === 'total bytes' ? 4 : 8
    })

    let runtime = await fixture.start()
    const document = stage === 'message size' ? { file_size: 5 } : {}
    expect((await webhook(runtime.origin, 700, document)).status).toBe(204)
    expect((await runtime.core.status()).requests).toEqual([])
    expect(fixture.routine.traffic).toEqual([])
    expect(remote.traffic.map((item) => item.path)).toEqual(paths)
    expect((await webhook(runtime.origin, 701)).status).toBe(204)
    await runtime.stop()
    runtime = await fixture.start()
    expect((await runtime.core.status()).requests).toMatchObject([
      { snapshot: { source: { eventId: '701' }, text: 'later text' } }
    ])
    expect((await webhook(runtime.origin, 701)).status).toBe(204)
    await runtime.core.processDue()
    expect((await runtime.core.status()).requests).toHaveLength(1)
    expect(fixture.routine.traffic).toHaveLength(1)
  }
)

it.each(['getFile 503', 'download 503', 'download disconnect'])(
  'leaves %s unacknowledged so the same update can be saved after restart',
  async (failure) => {
    let failed = true

    const remote = await mediaPeer((traffic) => {
      if (failed && failure === 'getFile 503') {
        return { status: 503, json: { ok: false, error_code: 503 } }
      }
      if (traffic.method === 'GET') {
        if (failed) {
          return failure === 'download disconnect'
            ? { drop: true }
            : { status: 503 }
        }
        return { data: Uint8Array.of(1, 2, 3), mimeType: 'application/pdf' }
      }
      return {
        json: {
          ok: true,
          result: {
            file_id: 'native-document',
            file_unique_id: 'document-unique',
            file_size: 3,
            file_path: 'documents/file_1.pdf'
          }
        }
      }
    })

    cleanups.push(remote.close)

    const fixture = await ingressFixture(cleanups, remote.origin, {
      maxMediaBytes: 4
    })

    let runtime = await fixture.start()
    expect((await webhook(runtime.origin, 700, {})).status).toBe(503)
    expect((await runtime.core.status()).requests).toEqual([])
    expect(fixture.routine.traffic).toEqual([])
    await runtime.stop()
    failed = false
    runtime = await fixture.start()
    expect((await webhook(runtime.origin, 700, {})).status).toBe(204)
    expect((await webhook(runtime.origin, 700, {})).status).toBe(204)
    expect((await runtime.core.status()).requests).toHaveLength(1)
    await runtime.core.processDue()
    expect(fixture.routine.traffic).toHaveLength(1)
  }
)

it('keeps a real SQLite failure replayable and saves the same update after restart', async () => {
  const remote = await mediaPeer(() => ({ json: {} }))
  cleanups.push(remote.close)
  const fixture = await ingressFixture(cleanups, remote.origin, {})
  let runtime = await fixture.start()
  await runtime.storage.close()
  expect((await webhook(runtime.origin, 700)).status).toBe(503)
  expect(fixture.routine.traffic).toEqual([])
  await runtime.stop()
  runtime = await fixture.start()
  expect((await runtime.core.status()).requests).toEqual([])
  expect((await webhook(runtime.origin, 700)).status).toBe(204)
  expect((await webhook(runtime.origin, 700)).status).toBe(204)
  expect((await runtime.core.status()).requests).toHaveLength(1)
  await runtime.core.processDue()
  expect(fixture.routine.traffic).toHaveLength(1)
})
