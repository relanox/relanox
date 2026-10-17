import { installPeerNetwork } from './network.js'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createWeComChannel } from '../src/index.js'
import { wireText } from '../src/transport.js'
import { assemble, peer, records } from './test-support.js'

installPeerNetwork()

// Protect delayed native authentication through real WS traffic and SQLite.
// The old account-level 10s timer disconnected a still-recoverable SDK session;
// Existing peers authenticate immediately. No SDK or production seams are used.
// Published @wecom/aibot-node-sdk 1.0.7 dist/index.esm.js: handleFrame handles
// Aibot_subscribe ACKs; scheduleReconnect owns its own recovery policy.
test(
  'WeCom accepts a delayed subscription ACK without stopping the SDK connection',
  { timeout: 20_000 },
  async () => {
    vi.stubEnv('WECOM_SECRET', 'secret')

    const remote = await peer(
      () => ({ status: 404 }),
      (socket) => {
        socket.on('message', (raw) => {
          const frame = z
            .object({
              cmd: z.string(),
              headers: z.object({ req_id: z.string() })
            })
            .parse(JSON.parse(wireText(raw)))

          if (frame.cmd !== 'aibot_subscribe') {
            return
          }
          setTimeout(() => {
            if (socket.readyState !== 1) {
              return
            }
            socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
            socket.send(
              JSON.stringify({
                cmd: 'aibot_msg_callback',
                headers: { req_id: 'delayed-callback' },
                body: {
                  msgid: 'delayed-message',
                  aibotid: 'robot',
                  chattype: 'single',
                  from: { userid: 'user' },
                  msgtype: 'text',
                  text: { content: 'accepted after authentication' }
                }
              })
            )
          }, 10_500)
        })
      }
    )

    const host = await assemble(
      createWeComChannel(),
      { botId: 'robot', secret: { env: 'WECOM_SECRET' } },
      [{ chatId: 'user', senderId: 'user' }]
    )

    const starting = host.start()
    await expect
      .poll(
        async () =>
          (await records(host.storage)).map(
            (record) => record.snapshot.source.eventId
          ),
        { timeout: 13_000 }
      )
      .toEqual(['delayed-message'])
    await starting
    expect((await host.runtime.status()).connections['channels/bot']).toBe(
      'connected'
    )
    expect(remote.sockets).toHaveLength(1)
  }
)
