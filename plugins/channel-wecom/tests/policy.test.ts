import { installPeerNetwork } from './network.js'
import { expect, test, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { z } from 'zod'
import type { Json } from '@relanox/sdk'
import { createWeComChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import {
  assemble,
  peer,
  records,
  sendInput,
  temporaryDatabase
} from './test-support.js'
import {
  callbackConfig,
  callbackKey,
  callbackMessage,
  callbackRequest
} from './callback-peer.js'

installPeerNetwork()

type Mode = 'websocket' | 'webhook'

type Runtime = Awaited<ReturnType<typeof assemble>>['runtime']

function credentials(): void {
  vi.stubEnv('WECOM_POLICY_SECRET', 'secret')
  vi.stubEnv('CALLBACK_TOKEN', 'callback-token')
  vi.stubEnv('CALLBACK_KEY', callbackKey.toString('base64').replace(/=+$/u, ''))
}

function configFor(mode: Mode): Json {
  return mode === 'webhook'
    ? callbackConfig
    : { botId: 'robot', secret: { env: 'WECOM_POLICY_SECRET' } }
}

// Native media encryption and callback/file/mixed bodies: WecomTeam/aibot-node-sdk
// 80615b987ef69c6028ad764924609247c0725955, src/crypto.ts and
// Src/types/message.ts. SDK src/ws.ts handleFrame dispatches inbound callbacks
// Without a separate ACK; subscribe/ping/outbound operations receive errcode ACKs.
// The HTTP empty response is a policy discard, as for account-denied callbacks.
function encryptedFile(bytes: Buffer): Buffer {
  const cipher = createCipheriv(
    'aes-256-cbc',
    callbackKey,
    callbackKey.subarray(0, 16)
  )

  cipher.setAutoPadding(false)
  const padding = 32 - (bytes.length % 32)
  return Buffer.concat([
    cipher.update(Buffer.concat([bytes, Buffer.alloc(padding, padding)])),
    cipher.final()
  ])
}

async function platformPeer(
  download: Parameters<typeof peer>[0]
): ReturnType<typeof peer> {
  return peer(download, (socket) => {
    socket.on('message', (raw) => {
      const frame = z
        .object({ headers: z.object({ req_id: z.string() }) })
        .parse(JSON.parse(wireText(raw)))

      socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
    })
  })
}

/** Forward HTTP bytes to the public runtime boundary; no policy, retry or storage simulation. */
async function callbackPeer(runtime: Runtime): ReturnType<typeof peer> {
  return peer(async (request) => {
    const response = await runtime.fetch(
      new Request(`https://relay.example${request.path}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body)
      })
    )

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer())
    }
  })
}

async function postCallback(origin: string, body: object): Promise<Response> {
  const request = callbackRequest(body)
  const url = new URL(request.url)
  return fetch(new Request(`${origin}${url.pathname}${url.search}`, request))
}

function fileMessage(mode: Mode, url: string, id: string): object {
  return {
    ...callbackMessage(id),
    text: undefined,
    msgtype: 'file',
    file: {
      url,
      ...(mode === 'websocket'
        ? { aeskey: callbackKey.toString('base64') }
        : {})
    }
  }
}

function socketCallback(
  remote: Awaited<ReturnType<typeof peer>>,
  body: object
): void {
  const socket = remote.sockets.at(-1)
  if (!socket) {
    throw new Error('missing_platform_connection')
  }
  socket.send(
    JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'incoming-callback' },
      body
    })
  )
}

function mixedMessage(mode: Mode, url: string): object {
  return {
    ...callbackMessage('policy-media'),
    text: undefined,
    msgtype: 'mixed',
    mixed: {
      msg_item: [
        { msgtype: 'text', text: { content: 'two images' } },
        ...Array.from({ length: 2 }, () => ({
          msgtype: 'image',
          image: {
            url,
            ...(mode === 'websocket'
              ? { aeskey: callbackKey.toString('base64') }
              : {})
          }
        }))
      ]
    }
  }
}

const scenarios = [
  {
    name: 'ciphertext bound',
    bytes: Buffer.alloc(1057, 65),
    worker: { maxMediaBytes: 1024 }
  },
  {
    name: 'plaintext bound',
    bytes: Buffer.alloc(1025, 65),
    worker: { maxMediaBytes: 1024 }
  },
  {
    name: 'attachment count',
    // Complete 1x1 PNG, not an empty or undecodable image.
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=',
      'base64'
    ),
    worker: { maxAttachments: 1 }
  },
  {
    name: 'aggregate bytes',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=',
      'base64'
    ),
    worker: { maxTotalMediaBytes: 100 }
  }
] as const

const policyCases = (['websocket', 'webhook'] as const).flatMap((mode) =>
  scenarios.map((scenario) => ({ mode, scenario }))
)

test.each(policyCases)(
  'WeCom $mode discards $scenario.name without disturbing later messages or durable recovery',
  async ({ mode, scenario }) => {
    credentials()

    const remote = await platformPeer((request) => ({
      body: encryptedFile(
        request.path === '/allowed'
          ? Buffer.from('allowed file')
          : scenario.bytes
      ),
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="native.bin"'
      }
    }))

    const plugin = createWeComChannel()
    const filename = await temporaryDatabase()

    const host = await assemble(
      plugin,
      configFor(mode),
      [{ chatId: 'user', senderId: 'user' }],
      filename,
      undefined,
      scenario.worker
    )

    await host.start()

    const callbacks =
      mode === 'webhook' ? await callbackPeer(host.runtime) : undefined

    const oversized =
      'maxMediaBytes' in scenario.worker
        ? fileMessage(mode, `${remote.http}/refused`, 'policy-media')
        : mixedMessage(mode, `${remote.http}/refused`)

    if (callbacks) {
      const response = await postCallback(callbacks.http, oversized)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('')
      expect((await host.principal().status()).channels[0]?.send).toMatchObject(
        { status: 'unavailable', reason: 'address_unresolved' }
      )
    } else {
      socketCallback(remote, oversized)
      await expect
        .poll(() => remote.requests.length)
        .toBe('maxMediaBytes' in scenario.worker ? 1 : 2)
      // A native independent send proves that policy refusal did not close the
      // Authenticated connection. No fabricated inbound ACK is expected.
      expect(
        await plugin.send(
          sendInput('wecom', 'user', {
            chattype: 'single',
            scope: { botId: 'robot', wsUrl: 'wss://openws.work.weixin.qq.com/' }
          })
        )
      ).toMatchObject({ status: 'sent' })
      expect(remote.sockets).toHaveLength(1)
    }
    expect(await records(host.storage)).toEqual([])

    const later = fileMessage(
      mode,
      `${remote.http}/allowed`,
      'allowed-after-policy'
    )

    if (callbacks) {
      expect((await postCallback(callbacks.http, later)).status).toBe(200)
    } else {
      socketCallback(remote, later)
    }
    await expect
      .poll(async () =>
        (await records(host.storage)).map(
          (record) => record.snapshot.source.eventId
        )
      )
      .toEqual(['allowed-after-policy'])
    await plugin.stop?.()
    await host.storage.close()

    const recovered = await assemble(
      createWeComChannel(),
      configFor(mode),
      [{ chatId: 'user', senderId: 'user' }],
      filename,
      undefined,
      scenario.worker
    )

    expect(
      (await records(recovered.storage)).map(
        (record) => record.snapshot.source.eventId
      )
    ).toEqual(['allowed-after-policy'])
    await recovered.storage.close()
  }
)

test.each(['websocket', 'webhook'] as const)(
  'WeCom %s keeps native download failures replayable through real HTTP and SQLite',
  async (mode) => {
    credentials()
    let unavailable = true

    const remote = await platformPeer(() =>
      unavailable
        ? { status: 503, body: { error: 'temporarily unavailable' } }
        : {
            body: encryptedFile(Buffer.from('recoverable file')),
            headers: { 'content-type': 'application/octet-stream' }
          }
    )

    const host = await assemble(
      createWeComChannel(),
      configFor(mode),
      [{ chatId: 'user', senderId: 'user' }],
      await temporaryDatabase(),
      undefined,
      { maxMediaBytes: 1024 }
    )

    await host.start()

    const callbacks =
      mode === 'webhook' ? await callbackPeer(host.runtime) : undefined

    const message = fileMessage(
      mode,
      `${remote.http}/download`,
      'retry-download'
    )

    if (callbacks) {
      expect((await postCallback(callbacks.http, message)).status).toBe(503)
    } else {
      socketCallback(remote, message)
      await expect.poll(() => remote.sockets[0]?.readyState).toBe(3)
    }
    expect(await records(host.storage)).toEqual([])
    unavailable = false
    if (callbacks) {
      expect((await postCallback(callbacks.http, message)).status).toBe(200)
    } else {
      await expect.poll(() => remote.sockets.length, { timeout: 4000 }).toBe(2)
      await expect
        .poll(
          async () => (await host.runtime.status()).connections['channels/bot']
        )
        .toBe('connected')
      socketCallback(remote, message)
    }
    await expect
      .poll(async () =>
        (await records(host.storage)).map(
          (record) => record.snapshot.source.eventId
        )
      )
      .toEqual(['retry-download'])
    expect(remote.requests).toHaveLength(2)
  }
)
