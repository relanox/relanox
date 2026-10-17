import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { socketPeer } from './peer.js'
import { fixture } from './authorization-runtime.js'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Native hello/disconnect frames and apps.connections.open response:
// https://docs.slack.dev/apis/events-api/using-socket-mode
// https://docs.slack.dev/reference/methods/apps.connections.open/
// SDK 3.1.0 retries connections after its default 5s client ping timeout:
// https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/socket-mode/src/SocketModeClient.ts
async function reconnecting(mode: 'no hello' | 'invalid_auth'): Promise<{
  runtime: Awaited<ReturnType<typeof fixture>>
  connections(this: void): number
  opens(this: void): number
  disconnect(this: void): void
  unhandled: unknown[]
}> {
  const unhandled: unknown[] = []

  const rejected = (reason: unknown): void => {
    unhandled.push(reason)
  }

  process.on('unhandledRejection', rejected)
  cleanup.push(async () => {
    process.removeListener('unhandledRejection', rejected)
  })
  const wss = await socketPeer((server) => new WebSocketServer({ server }))
  cleanup.push(async () => {
    for (const socket of wss.clients) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve()
      })
    })
  })
  const address = wss.address()
  if (address === null || typeof address === 'string') {
    throw new Error('missing_socket_address')
  }
  let first: WebSocket | undefined
  let connections = 0
  wss.on('connection', (socket) => {
    connections++
    if (connections === 1) {
      first = socket
      socket.send(JSON.stringify({ type: 'hello' }))
    }
  })
  let opens = 0

  const remote = await mediaPeer((traffic) => {
    if (traffic.path === '/auth.test') {
      return {
        json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' }
      }
    }
    opens++
    return {
      json:
        mode === 'invalid_auth' && opens > 1
          ? { ok: false, error: 'invalid_auth' }
          : { ok: true, url: `ws://127.0.0.1:${address.port}` }
    }
  })

  cleanup.push(remote.close)
  routePlatform('https://slack.com', registerPeer(remote.origin))
  const runtime = await fixture(':memory:', cleanup, true)
  await runtime.plugin.start?.(new AbortController().signal)
  await expect
    .poll(async () => (await runtime.core.status()).connections['channels/sl'])
    .toBe('connected')
  return {
    runtime,
    connections: () => connections,
    opens: () => opens,
    unhandled,
    disconnect() {
      if (!first) {
        throw new Error('missing_initial_socket')
      }
      first.send(
        JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })
      )
    }
  }
}

// Existing reconnect coverage sends hello immediately on connection two. A real
// Stop can land before that hello, rejecting the SDK-owned start promise with
// Undefined. Keep Vitest's rejection handler and explicitly verify the count.
// Real SQLite hosts the channel; no SDK mocks or production seams are needed.
it('stops an SDK reconnect before hello without leaking a rejection or reconnecting again', async () => {
  const peer = await reconnecting('no hello')
  peer.disconnect()
  await expect.poll(peer.connections, { timeout: 8000 }).toBe(2)
  const started = performance.now()
  await peer.runtime.plugin.stop?.()
  expect(performance.now() - started).toBeLessThan(1000)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 5200)
  })
  expect(peer.connections()).toBe(2)
  expect(peer.opens()).toBe(2)
  expect(peer.unhandled).toEqual([])
}, 20_000)

// Initial startup errors never exercise the SDK-owned reconnect promise. The
// Runtime must still report a later invalid_auth response as degraded.
it('reports a rejected SDK reconnect instead of swallowing a non-shutdown failure', async () => {
  const peer = await reconnecting('invalid_auth')
  peer.disconnect()
  await expect
    .poll(
      async () => (await peer.runtime.core.status()).connections['channels/sl'],
      { timeout: 8000 }
    )
    .toBe('degraded')
  expect(peer.opens()).toBe(2)
  expect(peer.connections()).toBe(1)
  expect(peer.unhandled).toEqual([])
})
