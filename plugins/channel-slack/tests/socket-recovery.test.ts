import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
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

// Native envelope and file reference contracts:
// https://docs.slack.dev/apis/events-api/using-socket-mode
// https://docs.slack.dev/reference/events/message/file_share
function fileEvent(eventId: string, envelopeId: string): string {
  return JSON.stringify({
    type: 'events_api',
    envelope_id: envelopeId,
    payload: {
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: eventId,
      event: {
        type: 'message',
        subtype: 'file_share',
        user: 'U42',
        channel: 'C7',
        ts: '1700000000.002',
        files: [
          {
            id: 'F123',
            name: 'sample.txt',
            mimetype: 'text/plain',
            size: 5,
            url_private_download:
              'https://files.slack.com/files-pri/T1-F123/sample.txt'
          }
        ]
      }
    }
  })
}

// A failed handoff must leave its envelope unacknowledged without stopping the
// SDK session. Existing ACK and transport reconnect cases never deliver again
// After a handoff failure. This uses real SQLite and public protocol peers only.
it('accepts subsequent Socket Mode events and redelivery after a failed file download', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => {
    wss.once('listening', resolve)
  })
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
  const url = `ws://127.0.0.1:${address.port}`
  let available = false

  const remote = await mediaPeer((traffic) => {
    if (traffic.path === '/auth.test') {
      return {
        json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' }
      }
    }
    if (traffic.path === '/apps.connections.open') {
      return { json: { ok: true, url } }
    }
    return {
      status: available ? 200 : 503,
      data: Uint8Array.of(104, 101, 108, 108, 111),
      mimeType: 'text/plain'
    }
  })

  cleanup.push(remote.close)
  const peerUrl = registerPeer(remote.origin)
  routePlatform('https://slack.com', peerUrl)
  routePlatform('https://files.slack.com', peerUrl)
  const runtime = await fixture(':memory:', cleanup, true)
  const frames: unknown[] = []
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      if (!Buffer.isBuffer(raw)) {
        throw new TypeError('unexpected_frame_bytes')
      }
      frames.push(JSON.parse(raw.toString('utf8')))
    })
    socket.send(JSON.stringify({ type: 'hello' }))
    socket.send(fileEvent('EvFailed', 'failed'))
  })
  await runtime.plugin.start?.(new AbortController().signal)
  await expect
    .poll(() => remote.traffic.filter((item) => item.method === 'GET').length)
    .toBe(1)
  await expect
    .poll(async () => (await runtime.core.status()).connections['channels/sl'])
    .not.toBe('connected')
  expect(frames).toEqual([])
  expect(await runtime.storage.listInbound({ limit: 10 })).toEqual([])
  available = true
  for (const socket of wss.clients) {
    socket.send(fileEvent('EvSubsequent', 'subsequent'))
  }
  await expect
    .poll(() => frames)
    .toContainEqual({ envelope_id: 'subsequent', payload: {} })
  for (const socket of wss.clients) {
    socket.send(fileEvent('EvFailed', 'redelivered'))
  }
  await expect
    .poll(() => frames)
    .toContainEqual({ envelope_id: 'redelivered', payload: {} })
  const accepted = await runtime.storage.listInbound({ limit: 10 })
  expect(
    accepted.map((record) => record.snapshot.source.eventId).toSorted()
  ).toEqual(['EvFailed', 'EvSubsequent'])
  expect(accepted.map((record) => record.snapshot.attachments)).toMatchObject([
    [{ kind: 'file', mimeType: 'text/plain', size: 5 }],
    [{ kind: 'file', mimeType: 'text/plain', size: 5 }]
  ])
  expect(frames).not.toContainEqual({ envelope_id: 'failed', payload: {} })
  expect(
    remote.traffic.filter((item) => item.path === '/apps.connections.open')
  ).toHaveLength(1)
})
