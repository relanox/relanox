import type { ServerResponse } from 'node:http'
import { createCore } from '@relanox/core'
import type { WorkerOptions } from '@relanox/core'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createGrokAgentPlugin } from '../../agent-grok/src/index.js'
import {
  body,
  cleanup,
  databaseFile,
  httpPeer,
  json,
  observations,
  waitFor
} from '../../channel-matrix/tests/harness.js'
import { createSignalChannel } from '../src/index.js'

const account = '+10000000001'
const sender = '11111111-1111-4111-8111-111111111111'
const scope = { pluginId: 'channel-signal', ownerId: 'bot' }

// Native contract: signal-cli 1da2a51c1e68c21871a96046ac8258ba1edd72e7.
// JsonAttachment.java permits a null size; GetAttachmentCommand.java emits
// Base64.getEncoder().encodeToString(readAllBytes()), including '' for empty files.
// AttachmentStore.java persists generic files without a positive-length restriction.
// SseEventBuffer.java replays events after Last-Event-ID (the last 1000 in memory).
// https://github.com/AsamK/signal-cli/tree/1da2a51c1e68c21871a96046ac8258ba1edd72e7/src/main/java/org/asamk/signal
function frame(response: ServerResponse, id: string, message: unknown): void {
  response.write(
    `id: ${id}\nevent: receive\ndata: ${JSON.stringify({ account, envelope: { sourceUuid: sender, timestamp: 1_800_000_000_000, dataMessage: message } })}\n\n`
  )
}

async function fixture(
  base: string,
  worker: WorkerOptions,
  filename?: string
): Promise<{
  storage: ReturnType<typeof createSqliteStorage>
  plugin: ReturnType<typeof createSignalChannel>
  observation: ReturnType<typeof observations>
}> {
  const storage = createSqliteStorage({
    filename: filename ?? (await databaseFile())
  })

  await storage.initialize()
  const plugin = createSignalChannel()
  const agent = createGrokAgentPlugin()
  const observation = observations()
  cleanup(async () => {
    await plugin.stop?.()
    await agent.stop?.()
    await storage.close()
  })

  await createCore({
    publicUrl: 'https://relay.example',
    storage,
    channels: new Map([['bot', plugin]]),
    agents: new Map([['grok', agent]]),
    worker,
    observe: observation.observe,
    config: {
      accounts: [
        {
          id: 'bot',
          channel: 'signal',
          config: { serviceUrl: base, account, allowInsecureLocalhost: true },
          allowedSenders: [sender]
        }
      ],
      endpoints: [
        {
          id: 'worker',
          agent: 'grok',
          config: {
            mcp: { token: { env: 'SIGNAL_TEST_MCP_TOKEN' } },
            routineUrl: { env: 'SIGNAL_TEST_ROUTINE' },
            routineAuthorization: { env: 'SIGNAL_TEST_ROUTINE_AUTH' }
          }
        }
      ],
      bindings: [
        { accountId: 'bot', endpointId: 'worker', chatId: `direct:${sender}` }
      ],
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  return { storage, plugin, observation }
}

const cases: readonly {
  name: string
  bytes: number
  count: number
  size?: number
  worker: WorkerOptions
  downloads: number
  errorCode: string
}[] = [
  {
    name: 'declared per-file size',
    bytes: 9,
    count: 1,
    size: 9,
    worker: { maxMediaBytes: 8 },
    downloads: 0,
    errorCode: 'media_too_large'
  },
  {
    name: 'decoded per-file size',
    bytes: 9,
    count: 1,
    worker: { maxMediaBytes: 8 },
    downloads: 1,
    errorCode: 'media_too_large'
  },
  {
    name: 'bounded base64 response',
    bytes: 20_000,
    count: 1,
    worker: { maxMediaBytes: 8 },
    downloads: 1,
    errorCode: 'media_response_too_large'
  },
  {
    name: 'aggregate size',
    bytes: 6,
    count: 2,
    worker: { maxMediaBytes: 8, maxTotalMediaBytes: 8 },
    downloads: 2,
    errorCode: 'media_total_too_large'
  },
  {
    name: 'attachment count',
    bytes: 1,
    count: 2,
    worker: { maxAttachments: 1 },
    downloads: 2,
    errorCode: 'too_many_attachments'
  },
  {
    name: 'empty generic file policy',
    bytes: 0,
    count: 1,
    size: 0,
    worker: {},
    downloads: 1,
    errorCode: 'media_too_large'
  }
]

it.each(cases)(
  'consumes $name policy rejection and ingests the following native text',
  async ({ bytes, count, size, worker, downloads, errorCode }) => {
    const requests: unknown[] = []
    const lastIds: (string | undefined)[] = []

    const peer = await httpPeer(async (request, response) => {
      if (request.url?.startsWith('/api/v1/events')) {
        const lastId = request.headers['last-event-id']
        lastIds.push(typeof lastId === 'string' ? lastId : undefined)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        frame(response, '1800000000000-1', {
          timestamp: 1,
          message: 'checkpoint before policy'
        })
        frame(response, '1800000000000-2', {
          timestamp: 2,
          attachments: Array.from({ length: count }, (_, index) => ({
            id: `native-${index}.txt`,
            contentType: 'text/plain',
            filename: `native-${index}.txt`,
            size: size ?? null
          }))
        })
        frame(response, '1800000000000-3', {
          timestamp: 3,
          message: 'after policy rejection'
        })
        return
      }

      const rpc = z
        .object({
          id: z.string(),
          method: z.literal('getAttachment'),
          params: z.object({
            account: z.literal(account),
            id: z.string(),
            recipient: z.literal(sender)
          })
        })
        .parse(await body(request))

      requests.push(rpc.params)
      json(response, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: { data: Buffer.alloc(bytes, 65).toString('base64') }
      })
    })

    const test = await fixture(peer.base, worker)
    await test.plugin.start?.(new AbortController().signal)
    await waitFor(
      async () => (await test.storage.listInbound({ limit: 10 })).length === 2
    )
    await test.plugin.stop?.()
    expect(
      (await test.storage.listInbound({ limit: 10 }))
        .map((item) => item.snapshot.text)
        .toSorted()
    ).toEqual(['after policy rejection', 'checkpoint before policy'])
    expect((await test.storage.getState(scope, 'events'))?.value).toBe(
      '1800000000000-3'
    )
    expect(requests).toHaveLength(downloads)
    expect(lastIds).toEqual([undefined])
    expect(
      test.observation.logs.some(
        (entry) => entry.fields?.errorCode === errorCode
      )
    ).toBe(true)
  }
)

it.each(['http503', 'mismatched-rpc-id', 'closed-sqlite'] as const)(
  'preserves the checkpoint on %s and recovers native media after SQLite reopening',
  async (failure) => {
    const lastIds: (string | undefined)[] = []
    let release: (() => void) | undefined
    let failed = true
    let downloads = 0

    const peer = await httpPeer(async (request, response) => {
      if (request.url?.startsWith('/api/v1/events')) {
        const lastId = request.headers['last-event-id']
        lastIds.push(typeof lastId === 'string' ? lastId : undefined)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.flushHeaders()

        const send = (): void => {
          frame(response, '1800000000000-2', {
            timestamp: 2,
            attachments: [
              {
                id: 'native.txt',
                contentType: 'text/plain',
                filename: 'native.txt',
                size: 5
              }
            ]
          })
          frame(response, '1800000000000-3', {
            timestamp: 3,
            message: 'after recovery'
          })
        }

        if (failed) {
          release = send
        } else {
          send()
        }
        return
      }

      const rpc = z
        .object({ id: z.string(), method: z.literal('getAttachment') })
        .parse(await body(request))

      downloads += 1
      if (failed && failure === 'http503') {
        json(response, {}, 503)
      } else {
        json(response, {
          jsonrpc: '2.0',
          id:
            failed && failure === 'mismatched-rpc-id' ? 'another-call' : rpc.id,
          result: { data: 'aGVsbG8=' }
        })
      }
    })

    const filename = await databaseFile()
    const first = await fixture(peer.base, { maxMediaBytes: 8 }, filename)
    await first.storage.compareAndSetState(scope, {
      key: 'events',
      expectedVersion: null,
      value: '1800000000000-1'
    })
    await first.plugin.start?.(new AbortController().signal)
    await waitFor(() => release !== undefined)
    if (failure === 'closed-sqlite') {
      await first.storage.close()
    }
    release?.()
    await waitFor(() =>
      first.observation.logs.some(
        (entry) => entry.fields?.errorCode === 'receive_failed'
      )
    )
    await first.plugin.stop?.()
    await first.storage.close()
    failed = false
    const next = await fixture(peer.base, { maxMediaBytes: 8 }, filename)
    expect((await next.storage.getState(scope, 'events'))?.value).toBe(
      '1800000000000-1'
    )
    expect(await next.storage.listInbound({ limit: 10 })).toEqual([])
    await next.plugin.start?.(new AbortController().signal)
    await waitFor(
      async () =>
        (await next.storage.getState(scope, 'events'))?.value ===
        '1800000000000-3'
    )
    await next.plugin.stop?.()
    const inbound = await next.storage.listInbound({ limit: 10 })
    expect(inbound).toHaveLength(2)
    expect(inbound.map((item) => item.snapshot.text).toSorted()).toEqual([
      '',
      'after recovery'
    ])

    const attachment = inbound.find((item) => item.snapshot.attachments?.length)
      ?.snapshot.attachments?.[0]

    expect(attachment).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
      fileName: 'native.txt',
      size: 5
    })
    if (!attachment) {
      throw new Error('Missing recovered attachment')
    }
    expect(
      (
        await next.storage.media?.get(
          inbound[0]?.snapshot.channel.id ?? '',
          attachment.id
        )
      )?.data
    ).toEqual(new Uint8Array(Buffer.from('hello')))
    expect(downloads).toBe(2)
    expect(lastIds).toEqual(['1800000000000-1', '1800000000000-1'])
  }
)
