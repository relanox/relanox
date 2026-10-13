import {
  installPeerNetwork,
  routePlatform,
  registerPeer
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { WorkerOptions } from '../../../packages/core/src/index.js'
import { fixture } from './authorization-runtime.js'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'
import type {
  MediaReply,
  MediaTraffic
} from '../../channel-telegram/tests/media-peer.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Native message File fields, including optional private URLs:
// https://github.com/slackapi/node-slack-sdk/blob/e02e7feeb500bfde1f947401a639633e42ce2f91/packages/types/src/events/message.ts
function nativeFile(id = 'F123', size = 5): Record<string, unknown> {
  return {
    id,
    created: 1_700_000_000,
    name: `${id}.txt`,
    title: `${id}.txt`,
    mimetype: 'text/plain',
    filetype: 'text',
    pretty_type: 'Plain Text',
    user: 'U42',
    editable: false,
    size,
    mode: 'hosted',
    is_external: false,
    external_type: null,
    is_public: false,
    public_url_shared: false,
    display_as_bot: false,
    username: null,
    permalink: `https://workspace.slack.com/files/U42/${id}`,
    channels: ['C7'],
    groups: [],
    url_private_download: `https://files.slack.com/files-pri/T1-${id}/${id}.txt`
  }
}

function envelope(eventId: string, files: readonly unknown[]): unknown {
  return {
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: eventId,
    event: {
      type: 'message',
      subtype: 'file_share',
      user: 'U42',
      channel: 'C7',
      channel_type: 'channel',
      ts: '1700000000.002',
      event_ts: '1700000000.002',
      text: 'files',
      files
    }
  }
}

async function deliver(origin: string, value: unknown): Promise<Response> {
  const body = JSON.stringify(value)
  const timestamp = String(Math.floor(Date.now() / 1000))
  return fetch(`${origin}/channels/sl/events`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', 'signing-secret').update(`v0:${timestamp}:${body}`).digest('hex')}`
    }
  })
}

async function platformPeer(
  respond: (traffic: MediaTraffic) => MediaReply
): Promise<Awaited<ReturnType<typeof mediaPeer>>> {
  const remote = await mediaPeer((traffic) =>
    traffic.path === '/auth.test'
      ? { json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' } }
      : respond(traffic)
  )

  cleanup.push(remote.close)
  const url = registerPeer(remote.origin)
  routePlatform('https://slack.com', url)
  routePlatform('https://files.slack.com', url)
  return remote
}

// FilesInfoResponse.File.size is optional in the verified SDK response contract:
// https://github.com/slackapi/node-slack-sdk/blob/e02e7feeb500bfde1f947401a639633e42ce2f91/packages/web-api/src/types/response/FilesInfoResponse.ts
function fileMetadata(id = 'F123'): unknown {
  return {
    ok: true,
    file: {
      id,
      name: 'sample.txt',
      mimetype: 'text/plain',
      url_private_download: 'https://files.slack.com/files-pri/T1-F123/F123.txt'
    }
  }
}

const limitCases: {
  readonly limit: string
  readonly worker: WorkerOptions
  readonly fileCount: number
  readonly lookup: boolean
  readonly downloads: number
}[] = [
  {
    limit: 'declared size',
    worker: { maxMediaBytes: 4 },
    fileCount: 1,
    lookup: false,
    downloads: 0
  },
  {
    limit: 'downloaded size',
    worker: { maxMediaBytes: 4 },
    fileCount: 1,
    lookup: true,
    downloads: 1
  },
  {
    limit: 'attachment count',
    worker: { maxMediaBytes: 8, maxAttachments: 1 },
    fileCount: 2,
    lookup: false,
    downloads: 2
  },
  {
    limit: 'total bytes',
    worker: { maxMediaBytes: 8, maxTotalMediaBytes: 9 },
    fileCount: 2,
    lookup: false,
    downloads: 2
  }
]

it.each(limitCases)(
  'ACKs a fixed $limit rejection without persisting it and accepts the next file',
  async ({ worker, fileCount, lookup, downloads }) => {
    const remote = await platformPeer((traffic) => {
      if (traffic.path.startsWith('/files.info?')) {
        return { json: fileMetadata() }
      }
      return {
        data: Buffer.from(traffic.path.includes('F200') ? 'ok' : 'hello'),
        mimeType: 'text/plain'
      }
    })

    const runtime = await fixture(':memory:', cleanup, false, worker)

    const files = Array.from({ length: fileCount }, (_, index) => ({
      ...nativeFile(`F${123 + index}`),
      ...(lookup ? { url_private_download: undefined } : {})
    }))

    expect(
      (await deliver(runtime.origin, envelope('EvLimit', files))).status
    ).toBe(204)
    expect((await runtime.core.status()).requests).toEqual([])
    expect(
      remote.traffic.filter((item) => item.path.startsWith('/files-pri/'))
    ).toHaveLength(downloads)
    expect(
      (
        await deliver(
          runtime.origin,
          envelope('EvNext', [nativeFile('F200', 2)])
        )
      ).status
    ).toBe(204)
    const saved = (await runtime.core.status()).requests
    expect(saved).toHaveLength(1)
    expect(saved[0]?.snapshot.source.eventId).toBe('EvNext')
    expect(saved[0]?.snapshot.attachments).toMatchObject([
      { kind: 'file', mimeType: 'text/plain', size: 2 }
    ])
  }
)

it.each(['download HTTP 503', 'invalid native metadata'])(
  'keeps %s unacknowledged and accepts its healthy replay',
  async (failure) => {
    let unhealthy = true

    const remote = await platformPeer((traffic) => {
      if (traffic.path.startsWith('/files.info?')) {
        return { json: fileMetadata(unhealthy ? 'FOTHER' : 'F123') }
      }
      return {
        ...(unhealthy ? { status: 503 } : {}),
        data: Buffer.from('hello'),
        mimeType: 'text/plain'
      }
    })

    const runtime = await fixture(':memory:', cleanup, false, {
      maxMediaBytes: 5
    })

    const file = {
      ...nativeFile(),
      ...(failure === 'invalid native metadata'
        ? { url_private_download: undefined }
        : {})
    }

    const value = envelope('EvRetry', [file])
    expect((await deliver(runtime.origin, value)).status).toBe(503)
    expect((await runtime.core.status()).requests).toEqual([])
    unhealthy = false
    expect((await deliver(runtime.origin, value)).status).toBe(204)
    const saved = (await runtime.core.status()).requests
    expect(saved).toHaveLength(1)
    expect(saved[0]?.snapshot.source.eventId).toBe('EvRetry')
    expect(saved[0]?.snapshot.attachments).toMatchObject([
      { kind: 'file', mimeType: 'text/plain', size: 5 }
    ])
    expect(
      remote.traffic.filter((item) => item.path === '/auth.test')
    ).toHaveLength(1)
  }
)
