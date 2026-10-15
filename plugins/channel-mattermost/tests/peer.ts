import { WebSocketServer } from 'ws'
import { z } from 'zod'
import type { httpPeer } from '../../channel-matrix/tests/harness.js'
import { cleanup } from '../../channel-matrix/tests/harness.js'

// Mattermost 11.9.0 server/public/model/websocket_message.go and official
// Webapp/platform/client/src/websocket.ts: hello consumes sequence zero;
// Authentication and ping replies use the caller's seq as seq_reply.
export function websocketPeer(
  peer: Awaited<ReturnType<typeof httpPeer>>
): WebSocketServer {
  const server = new WebSocketServer({
    server: peer.server,
    path: '/api/v4/websocket'
  })

  server.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', peer.base)
    if (!url.searchParams.get('connection_id')) {
      socket.send(
        JSON.stringify({
          event: 'hello',
          seq: 0,
          data: { connection_id: 'abcdefghijklmnopqrstuvwxyz' }
        })
      )
    }
    socket.on('message', (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError('Expected a text protocol frame')
      }

      const frame = z
        .object({ action: z.string(), seq: z.number().int() })
        .parse(JSON.parse(bytes.toString()) as unknown)

      if (frame.action === 'ping') {
        socket.send(
          JSON.stringify({
            status: 'OK',
            seq_reply: frame.seq,
            data: { text: 'pong' }
          })
        )
      }
    })
  })
  cleanup(async () => {
    for (const socket of server.clients) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
  return server
}
