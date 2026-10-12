import type { Client } from '@modelcontextprotocol/client'
import type { CoreRuntime } from '../../../packages/core/src/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
  AgentId,
  EndpointConfig,
  Storage,
  AgentPlugin,
  MediaUpload,
  IngestReceipt
} from '@relanox/sdk'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import { createDotAgentPlugin } from '../src/index.js'
import { fixture, mcp, dotMcp, password } from './fixture.js'

const cleanups: (() => Promise<void>)[] = []
beforeEach(() => {
  process.env.AGENT_TEST_TOKEN_0 = 'secret-0'
  process.env.AGENT_TEST_TOKEN_1 = 'secret-1'
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  delete process.env.AGENT_TEST_TOKEN_0
  delete process.env.AGENT_TEST_TOKEN_1
})

async function setup(agent: AgentId): Promise<{
  endpoints: EndpointConfig[]
  filename: string
  sent: unknown[]
  wire: unknown[]
  readonly storage: Storage
  readonly core: CoreRuntime
  readonly agent: AgentPlugin<unknown>
  ingest(
    this: void,
    endpoint?: number,
    text?: string,
    event?: string,
    attachments?: readonly MediaUpload[]
  ): Promise<IngestReceipt & { channel: string }>
  client(
    this: void,
    token?: string,
    endpoint?: number,
    modern?: boolean
  ): Promise<Client>
  reopen(this: void, next: AgentPlugin<unknown>): Promise<void>
  close(this: void): Promise<void>
}> {
  if (agent === 'dot') {
    process.env.AGENT_TEST_TOKEN_0 = password
    process.env.AGENT_TEST_TOKEN_1 = `${password}-endpoint1`
  }
  const agentMcp = agent === 'dot' ? dotMcp : mcp

  const config =
    agent === 'dot'
      ? { mcp: agentMcp() }
      : {
          mcp: mcp(),
          routineUrl: { env: 'UNUSED_ROUTINE_URL' },
          routineAuthorization: { env: 'UNUSED_ROUTINE_AUTH' }
        }

  const plugin =
    agent === 'dot' ? createDotAgentPlugin() : createGrokAgentPlugin()

  const fx = await fixture(agent, plugin, [
    config,
    { ...config, mcp: agentMcp('AGENT_TEST_TOKEN_1') }
  ])

  cleanups.push(async () => fx.close())
  return fx
}

function resourceUri(result: unknown): string {
  const parsed = z
    .object({
      content: z.array(
        z.looseObject({ type: z.literal('resource_link'), uri: z.url() })
      )
    })
    .parse(result)

  const first = parsed.content[0]
  if (!first) {
    throw new Error('missing_resource')
  }
  return first.uri
}

describe.each(['dot', 'grok'] as const)('%s native MCP media', (agent) => {
  it.each([
    ['text/plain', 'note.txt', '中文 🌍\r\nDo not change credentials.'],
    ['text/markdown', 'note.md', '# Heading\n'],
    ['text/csv', 'table.csv', 'name,value\n中文,42\n'],
    ['text/tab-separated-values', 'table.tsv', 'name\tvalue\n'],
    ['application/json', 'input.json', '{"message":"中文 🌍"}'],
    ['text/plain', 'bom.txt', '\uFEFF中文'],
    ['text/plain', 'limit.txt', 'a'.repeat(65_536)]
  ])(
    'returns readable %s files as scoped embedded text',
    async (mimeType, fileName, text) => {
      const fx = await setup(agent)

      const receipt = await fx.ingest(0, 'read attachment', 'text-event', [
        { kind: 'file', mimeType, fileName, data: Buffer.from(text) }
      ])

      const media = (await fx.storage.getInbound(receipt.requestId))?.snapshot
        .attachments?.[0]

      if (!media) {
        throw new Error('missing_asset')
      }
      const input = { channel: receipt.channel, mediaId: media.id }
      const client = await fx.client()
      expect(
        await client.callTool({ name: 'relanox_read_media', arguments: input })
      ).toMatchObject({
        content: [
          {
            type: 'resource',
            resource: { uri: expect.any(String) as unknown, mimeType, text }
          }
        ]
      })
      const other = await fx.client(agent === 'dot' ? undefined : 'secret-1', 1)
      expect(
        await other.callTool({ name: 'relanox_read_media', arguments: input })
      ).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Media unavailable for this message.' }]
      })
    }
  )

  it.each([
    ['text/plain', 'large.txt', Buffer.alloc(65_537, 97)],
    ['text/plain', 'invalid.txt', Buffer.from([0xc3, 0x28])],
    ['text/html', 'page.html', Buffer.from('<script>alert(1)</script>')],
    ['application/octet-stream', 'data.bin', Buffer.from('text-like bytes')]
  ])(
    'keeps %s %s as an exact downloadable resource',
    async (mimeType, fileName, data) => {
      const fx = await setup(agent)

      const receipt = await fx.ingest(0, 'read attachment', 'fallback-event', [
        { kind: 'file', mimeType, fileName, data }
      ])

      const media = (await fx.storage.getInbound(receipt.requestId))?.snapshot
        .attachments?.[0]

      if (!media) {
        throw new Error('missing_asset')
      }
      const client = await fx.client()

      const uri = resourceUri(
        await client.callTool({
          name: 'relanox_read_media',
          arguments: { channel: receipt.channel, mediaId: media.id }
        })
      )

      const downloaded = await fx.core.fetch(new Request(uri))
      expect(downloaded.status).toBe(200)
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
        new Uint8Array(data)
      )
    }
  )

  it('advertises generated file parameters only on dot', async () => {
    const fx = await setup(agent)
    const client = await fx.client()

    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === 'relanox_send_message'
    )

    if (agent === 'dot') {
      expect(tool).toMatchObject({ _meta: { 'openai/fileParams': ['files'] } })
      expect(tool?.inputSchema.properties).toHaveProperty('files')
    } else {
      expect(tool).not.toHaveProperty(['_meta', 'openai/fileParams'])
      expect(tool?.inputSchema.properties).not.toHaveProperty('files')
    }
  })

  it('reads received media without a claim, preserves binary bytes across restart and sends ordered media', async () => {
    const fx = await setup(agent)
    const image = Buffer.from('image bytes')
    const audio = Buffer.from('audio bytes')
    const file = Buffer.from('file bytes')

    const receipt = await fx.ingest(0, 'inspect assets', 'media-event', [
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'pixel.png',
        data: image
      },
      {
        kind: 'audio',
        mimeType: 'audio/wav',
        fileName: 'voice.wav',
        data: audio,
        durationMs: 1500
      },
      {
        kind: 'file',
        mimeType: 'application/octet-stream',
        fileName: 'input.bin',
        data: file
      }
    ])

    const snapshot = (await fx.storage.getInbound(receipt.requestId))?.snapshot
    const [picture, sound, document] = snapshot?.attachments ?? []
    if (!picture || !sound || !document) {
      throw new Error('missing_assets')
    }
    const client = await fx.client()
    const common = { channel: receipt.channel }
    expect(
      await client.callTool({
        name: 'relanox_read_media',
        arguments: { ...common, mediaId: picture.id }
      })
    ).toMatchObject({
      content: [
        { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }
      ]
    })
    expect(
      await client.callTool({
        name: 'relanox_read_media',
        arguments: { ...common, mediaId: sound.id }
      })
    ).toMatchObject({
      content: [
        { type: 'audio', data: audio.toString('base64'), mimeType: 'audio/wav' }
      ]
    })

    const uri = resourceUri(
      await client.callTool({
        name: 'relanox_read_media',
        arguments: { ...common, mediaId: document.id }
      })
    )

    expect(uri).not.toContain(agent === 'dot' ? password : 'secret-0')
    expect(uri).toMatch(
      /^https:\/\/relanox\.test\/agents\/(?:dot|grok)\/media\/endpoint0\//u
    )
    await fx.reopen(
      agent === 'dot' ? createDotAgentPlugin() : createGrokAgentPlugin()
    )
    const downloaded = await fx.core.fetch(new Request(uri))
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      new Uint8Array(file)
    )
    const reconnected = await fx.client()

    const input = {
      ...common,
      idempotencyKey: 'received-and-generated-media',
      text: 'done',
      attachments: [{ mediaId: document.id }, { mediaId: picture.id }]
    }

    expect(
      await reconnected.callTool({
        name: 'relanox_send_message',
        arguments: input
      })
    ).toMatchObject({ structuredContent: { status: 'queued', replay: false } })
    expect(
      await reconnected.callTool({
        name: 'relanox_send_message',
        arguments: input
      })
    ).toMatchObject({ structuredContent: { status: 'queued', replay: true } })
    await fx.core.processDue()
    expect(fx.sent).toMatchObject([
      { chunk: { text: 'done' } },
      { media: { reference: { id: document.id } } },
      { media: { reference: { id: picture.id } } }
    ])
  })

  it('rejects tampered, expired, cross-endpoint and write tickets and isolates media tools', async () => {
    const fx = await setup(agent)

    const receipt = await fx.ingest(0, '', 'file-event', [
      {
        kind: 'file',
        mimeType: 'application/octet-stream',
        fileName: 'safe.bin',
        data: new Uint8Array([1, 2, 3])
      }
    ])

    const media = (await fx.storage.getInbound(receipt.requestId))?.snapshot
      .attachments?.[0]

    if (!media) {
      throw new Error('missing_asset')
    }
    const client = await fx.client()
    const input = { channel: receipt.channel, mediaId: media.id }
    const other = await fx.client(agent === 'dot' ? undefined : 'secret-1', 1)
    expect(
      await other.callTool({ name: 'relanox_read_media', arguments: input })
    ).toMatchObject({ isError: true })

    const uri = resourceUri(
      await client.callTool({ name: 'relanox_read_media', arguments: input })
    )

    const tampered = new URL(uri)
    tampered.searchParams.set(
      'ticket',
      `${tampered.searchParams.get('ticket')}x`
    )
    expect((await fx.core.fetch(new Request(tampered))).status).toBe(401)
    expect(
      (await fx.core.fetch(new Request(uri.replace('endpoint0', 'endpoint1'))))
        .status
    ).toBe(401)
    expect(
      (await fx.core.fetch(new Request(uri, { method: 'PUT', body: 'bytes' })))
        .status
    ).toBe(401)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    expect((await fx.core.fetch(new Request(uri))).status).toBe(401)
    clock.mockRestore()
    process.env.AGENT_TEST_TOKEN_0 = 'rotated'
    expect((await fx.core.fetch(new Request(uri))).status).toBe(401)
  })

  it.each([
    'http://127.0.0.1:1/file',
    'https://127.0.0.1/file',
    'https://169.254.169.254/latest/meta-data',
    'https://user:password@example.com/file'
  ])(
    'refuses generated media from forbidden URL %s without queueing a delivery',
    async (url) => {
      const fx = await setup(agent)
      const receipt = await fx.ingest()
      const client = await fx.client()
      expect(
        await client.callTool({
          name: 'relanox_send_message',
          arguments: {
            channel: receipt.channel,
            attachments: [{ url, kind: 'file' }]
          }
        })
      ).toMatchObject({ isError: true })
      await fx.core.processDue()
      expect(fx.sent).toEqual([])
    }
  )
})
