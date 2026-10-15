import type { Server } from 'node:net'
import type { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'

export { createServer } from 'node:http'

export type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http'

// Fetch rejects these ports before sending HTTP traffic, even on loopback.
// https://fetch.spec.whatwg.org/#port-blocking
// https://github.com/nodejs/node/blob/v26.11.1/deps/undici/src/lib/web/fetch/constants.js#L12-L20
const blockedPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10_080
])

/** Bind a real HTTP peer to an ephemeral port that native Fetch can reach. */
export async function listenPeer(server: Server): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('missing_peer_address')
    }
    if (!blockedPorts.has(address.port)) {
      return `http://127.0.0.1:${address.port}`
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }
  throw new Error('fetch_peer_port_unavailable')
}

/** WebSocket upgrades use Fetch's port checks in native and Undici clients. */
export async function socketPeer<T extends EventEmitter>(
  create: (server: HttpServer) => T
): Promise<T> {
  const server = createServer()
  await listenPeer(server)
  const socket = create(server)
  socket.once('close', () => {
    server.close()
  })
  return socket
}

/** Select an ephemeral port for a process that owns its listener lifecycle. */
export async function availablePort(): Promise<number> {
  const server = createServer()
  const origin = await listenPeer(server)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
  return Number(new URL(origin).port)
}
