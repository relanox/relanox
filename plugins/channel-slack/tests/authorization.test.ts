import {
  installPeerNetwork,
  routePlatform,
  registerPeer
} from '../../channel-wecom/tests/network.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from './authorization-runtime.js'
import { mediaPeer } from '../../channel-telegram/tests/media-peer.js'
import { WebSocketServer } from 'ws'

installPeerNetwork()

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Native file_share/file fields: https://docs.slack.dev/reference/events/message/file_share
// Private download bearer header: https://docs.slack.dev/reference/objects/file-object
function envelope(
  user: string,
  eventId: string,
  ts = '1700000000.002'
): unknown {
  return {
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: eventId,
    event: {
      type: 'message',
      user,
      channel: 'C7',
      ts,
      text: 'file',
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
}

async function deliver(
  origin: string,
  user: string,
  eventId: string,
  ts?: string
): Promise<Response> {
  const body = JSON.stringify(envelope(user, eventId, ts))
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

it('skips denied sender file downloads before authenticated HTTP acceptance and keeps storage failures replayable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-slack-auth-'))
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))

  const remote = await mediaPeer((traffic) =>
    traffic.path === '/auth.test'
      ? { json: { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' } }
      : { data: Uint8Array.of(104, 101, 108, 108, 111), mimeType: 'text/plain' }
  )

  cleanup.push(remote.close)
  const peerUrl = registerPeer(remote.origin)
  routePlatform('https://slack.com', peerUrl)
  routePlatform('https://files.slack.com', peerUrl)
  const filename = join(directory, 'relay.sqlite')
  const runtime = await fixture(filename, cleanup)
  expect((await deliver(runtime.origin, 'UDENIED', 'EvDenied')).status).toBe(
    204
  )
  expect(remote.traffic.filter((item) => item.method === 'GET')).toEqual([])
  expect((await runtime.core.status()).requests).toEqual([])
  expect((await deliver(runtime.origin, 'U42', 'EvAllowed')).status).toBe(204)
  expect(remote.traffic.filter((item) => item.method === 'GET')).toMatchObject([
    {
      path: '/files-pri/T1-F123/sample.txt',
      headers: { authorization: 'Bearer xoxb-token' }
    }
  ])
  const accepted = (await runtime.core.status()).requests
  expect(accepted).toHaveLength(1)
  expect(accepted[0]?.snapshot.senderId).toBe('U42')
  expect(accepted[0]?.snapshot.attachments).toMatchObject([
    { kind: 'file', mimeType: 'text/plain', size: 5 }
  ])
  await runtime.storage.close()
  expect(
    (await deliver(runtime.origin, 'U42', 'EvReplay', '1700000000.003')).status
  ).toBe(503)
  const restarted = await fixture(filename, cleanup)
  expect(
    (await deliver(restarted.origin, 'U42', 'EvReplay', '1700000000.003'))
      .status
  ).toBe(204)
  expect((await restarted.core.status()).requests).toHaveLength(2)
})

it('ACKs denied Socket Mode file shares without a download or durable inbound record', async () => {
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

  const url = registerPeer(`http://127.0.0.1:${address.port}`).replace(
    'https:',
    'wss:'
  )

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
  let connected = 0
  // Native socket wrapper: https://docs.slack.dev/apis/events-api/using-socket-mode
  wss.on('connection', (socket) => {
    connected++
    socket.send(JSON.stringify({ type: 'hello' }))
    socket.on('message', (raw) => {
      if (!Buffer.isBuffer(raw)) {
        throw new TypeError('unexpected_frame_bytes')
      }
      frames.push(JSON.parse(raw.toString('utf8')))
    })
    socket.send(
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'denied',
        payload: envelope('UDENIED', 'EvDeniedSocket')
      })
    )
  })
  await runtime.plugin.start?.(new AbortController().signal)
  await expect
    .poll(() => remote.traffic.map((item) => item.path))
    .toContain('/apps.connections.open')
  await expect.poll(() => connected).toBe(1)
  await expect.poll(() => frames).toContainEqual({ envelope_id: 'denied' })
  expect(remote.traffic.filter((item) => item.method === 'GET')).toEqual([])
  expect((await runtime.core.status()).requests).toEqual([])
  for (const socket of wss.clients) {
    socket.send(
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'allowed',
        payload: envelope('U42', 'EvAllowedSocket')
      })
    )
  }
  await expect.poll(() => frames).toContainEqual({ envelope_id: 'allowed' })
  expect(remote.traffic.filter((item) => item.method === 'GET')).toHaveLength(1)
  expect((await runtime.core.status()).requests).toHaveLength(1)
})
