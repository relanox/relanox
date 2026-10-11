import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  body,
  cleanup,
  httpPeer,
  json,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { mediaRelay } from '../../channel-matrix/tests/media-harness.js'
import { createMattermostChannel } from '../src/index.js'

const kinds = [
  ['image', 'image/png', 'picture.png', 201, 'sent'],
  ['audio', 'audio/ogg', 'voice.ogg', 201, 'sent'],
  ['video', 'video/mp4', 'clip.mp4', 201, 'sent'],
  ['file', 'application/pdf', 'report.pdf', 201, 'sent'],
  ['image', 'image/png', 'picture.png', 429, 'pending'],
  ['image', 'image/png', 'picture.png', 403, 'rejected'],
  ['image', 'image/png', 'picture.png', 503, 'pending'],
  ['image', 'image/png', 'picture.png', 200, 'pending']
] as const

it.each(kinds)(
  'relays native Mattermost %s (%s, %s) upload HTTP %s settles %s through SQLite and authenticated MCP',
  async (kind, mimeType, fileName, uploadStatus, expected) => {
    const received: { path: string; authorization: string | undefined }[] = []

    const uploaded: {
      bytes: Uint8Array
      contentType: string
      authorization: string | undefined
    }[] = []

    const posts: unknown[] = []

    const peer = await httpPeer(async (request, response) => {
      const path = request.url ?? '/'
      if (path === '/api/v4/files/asset/info') {
        received.push({ path, authorization: request.headers.authorization })
        json(response, {
          id: 'asset',
          name: fileName,
          mime_type: mimeType,
          size: 3
        })
      } else if (path === '/api/v4/files/asset') {
        received.push({ path, authorization: request.headers.authorization })
        response.writeHead(200, { 'Content-Type': mimeType })
        response.end(new Uint8Array([1, 2, 3]))
      } else if (path === '/api/v4/files') {
        const chunks: Uint8Array[] = []
        for await (const chunk of request) {
          chunks.push(chunk as Uint8Array)
        }
        uploaded.push({
          bytes: new Uint8Array(Buffer.concat(chunks)),
          contentType: request.headers['content-type'] ?? '',
          authorization: request.headers.authorization
        })
        json(
          response,
          uploadStatus === 201 ? { file_infos: [{ id: 'generated' }] } : {},
          uploadStatus
        )
      } else if (path === '/api/v4/posts') {
        posts.push(await body(request))
        json(response, { id: 'sent-post' }, 201)
      } else {
        json(response, {}, 404)
      }
    })

    const sockets = new WebSocketServer({
      server: peer.server,
      path: '/api/v4/websocket'
    })

    cleanup(async () => {
      for (const socket of sockets.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => {
          resolve()
        })
      })
    })
    sockets.on('connection', (socket) => {
      socket.once('message', (bytes) => {
        if (!Buffer.isBuffer(bytes)) {
          throw new TypeError('Expected text frame')
        }
        expect(JSON.parse(bytes.toString())).toMatchObject({
          action: 'authentication_challenge',
          data: { token: 'mattermost-secret' }
        })
        socket.send(JSON.stringify({ status: 'OK', seq_reply: 1 }))
        socket.send(
          JSON.stringify({
            event: 'posted',
            data: {
              post: JSON.stringify({
                id: 'incoming',
                user_id: 'alice',
                channel_id: 'channel',
                root_id: 'root',
                message: '',
                create_at: 1,
                file_ids: ['asset']
              })
            }
          })
        )
      })
    })

    const plugin = createMattermostChannel({
      MATTERMOST_TOKEN: 'mattermost-secret'
    })

    const fixture = await mediaRelay(
      plugin,
      {
        serverUrl: peer.base,
        botUserId: 'self-bot',
        token: { env: 'MATTERMOST_TOKEN' },
        allowInsecureLocalhost: true,
        reconnectMs: 100
      },
      [{ chatId: 'channel', threadId: 'root' }],
      ['alice']
    )

    await plugin.start?.(new AbortController().signal)
    await waitFor(
      async () =>
        (await fixture.storage.listInbound({ limit: 10 })).length === 1
    )
    await plugin.stop?.()
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
    if (!record) {
      throw new Error('Expected inbound')
    }

    const turn = await fixture.turn(record.snapshot.requestId, [
      { kind, mimeType, fileName, data: new Uint8Array([9, 8, 7]) }
    ])

    expect(turn.inbound[0]?.reference).toMatchObject({
      kind,
      mimeType,
      fileName
    })
    expect(turn.inbound[0]?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(received).toEqual([
      {
        path: '/api/v4/files/asset/info',
        authorization: 'Bearer mattermost-secret'
      },
      { path: '/api/v4/files/asset', authorization: 'Bearer mattermost-secret' }
    ])
    await fixture.runtime.processDue()
    expect(uploaded).toHaveLength(1)
    const upload = uploaded[0]
    if (!upload) {
      throw new Error('Expected upload')
    }

    const native = await new Response(new Uint8Array(upload.bytes), {
      headers: { 'Content-Type': upload.contentType }
    }).formData()

    const file = native.get('files')
    if (!(file instanceof File)) {
      throw new Error('Expected multipart file')
    }
    expect(native.get('channel_id')).toBe('channel')
    expect(file.name).toBe(fileName)
    expect(file.type).toBe(mimeType)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7])
    )
    expect(upload.authorization).toBe('Bearer mattermost-secret')
    if (expected !== 'sent') {
      expect(posts).toEqual([])
      expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
        expected
      )
      return
    }
    expect(posts).toEqual([
      {
        channel_id: 'channel',
        root_id: 'root',
        message: '',
        file_ids: ['generated']
      }
    ])
    expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
      'sent'
    )
  }
)
