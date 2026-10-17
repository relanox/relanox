import { registerPeer } from '../../channel-wecom/tests/network.js'
import { socketPeer } from '../../../tests/listen.js'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

export { mediaPeer } from '../../channel-telegram/tests/media-peer.js'

export async function discordPeer(): Promise<{
  url: string
  frames: unknown[]
  message(this: void, data: unknown, sequence?: number): void
  connected(this: void): boolean
  close(this: void): Promise<void>
}> {
  const server = await socketPeer(
    (http) => new WebSocketServer({ server: http })
  )

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('invalid_gateway_address')
  }

  const url = registerPeer(`http://127.0.0.1:${address.port}`).replace(
    'https:',
    'wss:'
  )

  let active: WebSocket | undefined
  const frames: unknown[] = []
  server.on('connection', (socket) => {
    active = socket
    socket.on('close', () => {
      if (active === socket) {
        active = undefined
      }
    })
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    socket.on('message', (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError('unexpected_gateway_bytes')
      }
      const frame: unknown = JSON.parse(bytes.toString('utf8'))
      frames.push(frame)
      if (
        typeof frame === 'object' &&
        frame !== null &&
        'op' in frame &&
        frame.op === 2
      ) {
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: 1,
            d: {
              session_id: '777',
              resume_gateway_url: url,
              user: { id: '999' }
            }
          })
        )
      }
      if (
        typeof frame === 'object' &&
        frame !== null &&
        'op' in frame &&
        frame.op === 1
      ) {
        socket.send(JSON.stringify({ op: 11 }))
      }
    })
  })
  return {
    url,
    frames,
    message(data: unknown, sequence = 2): void {
      if (!active) {
        throw new Error('gateway_not_connected')
      }
      active.send(
        JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: sequence, d: data })
      )
    },
    connected: () => active !== undefined,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        for (const client of server.clients) {
          client.terminate()
        }
        server.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
  }
}
