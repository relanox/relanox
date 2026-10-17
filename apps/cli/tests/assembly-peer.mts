import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import type { createPluginLoader } from '../src/plugin-loader.js'

type UploadClient = {
  on(event: string, listener: () => void): unknown
  connect(): void
  disconnect(): void
  uploadMedia(
    data: Buffer,
    options: { type: 'file'; filename: string }
  ): Promise<{ media_id: string }>
}

type SdkFactory = new (options: {
  botId: string
  secret: string
  wsUrl: string
  logger: Record<'debug' | 'info' | 'warn' | 'error', () => void>
}) => UploadClient

const destination = z.string().min(1).parse(process.argv[2])

const loaderModule = (await import(
  pathToFileURL(join(destination, 'dist/plugin-loader.js')).href
)) as { createPluginLoader: typeof createPluginLoader }

const loader = await loaderModule.createPluginLoader()
const channels: string[] = []
for (const id of ['matrix', 'msteams', 'wecom']) {
  const plugin = await loader.load('channel', id)
  if (plugin.kind !== 'channel') {
    throw new Error('unexpected_plugin_kind')
  }
  channels.push(plugin.channel)
}

const require = createRequire(
  pathToFileURL(
    join(destination, 'node_modules/@relanox/channel-wecom/package.json')
  )
)

const sdk = z
  .object({
    WSClient: z.custom<SdkFactory>((value) => typeof value === 'function')
  })
  .parse(
    await import(pathToFileURL(require.resolve('@wecom/aibot-node-sdk')).href)
  )

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(server, 'listening')
const address = z.object({ port: z.number() }).parse(server.address())
let chunks = 0

// Native upload ACKs and delayed-chunk regression: upstream SDK 1.0.7,
// https://github.com/WecomTeam/aibot-node-sdk/issues/27 and src/client.ts.
server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const data = Array.isArray(raw) ? Buffer.concat(raw) : raw

    const text =
      data instanceof ArrayBuffer
        ? Buffer.from(data).toString()
        : data.toString()

    const frame = z
      .object({
        cmd: z.string(),
        headers: z.object({ req_id: z.string() })
      })
      .parse(JSON.parse(text))

    const reply = JSON.stringify({
      headers: frame.headers,
      errcode: 0,
      body:
        frame.cmd === 'aibot_upload_media_init'
          ? { upload_id: 'assembled-upload' }
          : { media_id: 'assembled-media' }
    })

    if (frame.cmd === 'aibot_upload_media_chunk') {
      chunks += 1
      setTimeout(() => {
        socket.send(reply)
      }, 6000)
    } else {
      socket.send(reply)
    }
  })
})

const quiet = (): void => {}

const client = new sdk.WSClient({
  botId: 'assembled-bot',
  secret: 'assembled-secret',
  wsUrl: `ws://127.0.0.1:${address.port}`,
  logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }
})

try {
  await new Promise<void>((resolve) => {
    client.on('authenticated', resolve)
    client.connect()
  })

  const upload = await client.uploadMedia(Buffer.from('assembly upload'), {
    type: 'file',
    filename: 'assembly.txt'
  })

  process.stdout.write(
    JSON.stringify({ channels, mediaId: upload.media_id, chunks })
  )
} finally {
  client.disconnect()
  for (const socket of server.clients) {
    socket.terminate()
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}
