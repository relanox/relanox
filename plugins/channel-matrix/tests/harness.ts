import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createCore } from '@relanox/core'
import type {
  AgentPlugin,
  Binding,
  ChannelPlugin,
  Json,
  LogFields,
  Observability,
  Storage
} from '@relanox/sdk'
import { createSqliteStorage } from '@relanox/storage-sqlite'
import { afterEach } from 'vitest'
import { z } from 'zod'

const cleanups: (() => Promise<void>)[] = []

export function cleanup(action: () => Promise<void>): void {
  cleanups.push(action)
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const action of cleanups.toReversed()) {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }
  cleanups.length = 0
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Resource cleanup failed')
  }
})

export async function waitFor(
  check: () => Promise<boolean> | boolean
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await pause(20)
  }
  throw new Error('Observable condition timed out')
}

export async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function json(
  response: ServerResponse,
  value: unknown,
  status = 200
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

export async function httpPeer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<void> | void
) {
  const errors: unknown[] = []

  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      errors.push(error)
      response.destroy()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Missing peer address')
  }
  cleanup(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Peer failed')
    }
  })
  return { server, base: `http://127.0.0.1:${address.port}` }
}

export function observations() {
  const logs: { event: string; fields?: LogFields }[] = []

  const observe: Observability = {
    log(_level, event, fields) {
      logs.push({ event, ...(fields ? { fields } : {}) })
    },
    count() {},
    record() {},
    span() {
      return { end() {} }
    }
  }

  return { observe, logs }
}

export async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-open-'))
  cleanup(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return join(directory, 'state.sqlite')
}

/** Test agent transport delegates every business operation to the production host. */
function protocolAgent(dispatchUrl: string): AgentPlugin {
  return {
    id: 'agent-grok',
    kind: 'agent',
    agent: 'grok',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: () => ({}),
    async setup(host) {
      const principal = {
        subject: 'local-protocol-peer',
        endpointIds: ['worker']
      }

      host.mountHttp('/tools', async (request) => {
        if (
          request.headers.get('authorization') !==
          'Bearer fixture-agent-credential'
        ) {
          return new Response(null, { status: 401 })
        }

        const input = z
          .discriminatedUnion('method', [
            z.object({
              method: z.literal('claim'),
              requestId: z.string(),
              claimKey: z.string()
            }),
            z.object({
              method: z.literal('complete'),
              requestId: z.string(),
              claimToken: z.string(),
              resultId: z.string(),
              text: z.string()
            })
          ])
          .parse((await request.json()) as unknown)

        const scoped = host.forPrincipal(principal)

        const output =
          input.method === 'claim'
            ? await scoped.claim(input.requestId, input.claimKey)
            : await scoped.complete(input)

        return Response.json(output)
      })
    },
    async dispatch(input) {
      const response = await fetch(dispatchUrl, {
        method: 'POST',
        signal: input.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: input.request.requestId,
          text: input.request.text
        })
      })

      await response.body?.cancel()
      return response.ok
        ? { status: 'accepted' }
        : { status: 'unknown', errorCode: 'peer_dispatch_failed' }
    }
  }
}

export async function harness(
  plugin: ChannelPlugin<unknown>,
  config: Json,
  chats: readonly { chatId: string; threadId?: string }[],
  senders: readonly string[],
  dispatchUrl: string,
  options: { filename?: string; observe?: Observability } = {}
) {
  const filename = options.filename ?? (await databaseFile())

  const storage: Storage = createSqliteStorage({
    filename,
    busyTimeoutMs: 5000
  })

  await storage.initialize()

  const bindings: Binding[] = chats.map((chat) => ({
    accountId: 'bot',
    endpointId: 'worker',
    ...chat
  }))

  const runtime = await createCore({
    storage,
    channels: new Map([['bot', plugin]]),
    agents: new Map([['grok', protocolAgent(dispatchUrl)]]),
    ...(options.observe ? { observe: options.observe } : {}),
    config: {
      accounts: [
        { id: 'bot', channel: plugin.channel, config, allowedSenders: senders }
      ],
      endpoints: [
        { id: 'worker', agent: 'grok', dispatchMode: 'push', config: {} }
      ],
      bindings,
      storage: { plugin: 'sqlite', config: {} },
      observability: { plugin: 'none', config: {} }
    }
  })

  cleanup(async () => {
    await plugin.stop?.()
    await storage.close()
  })

  async function complete(requestId: string, text = 'delayed answer') {
    const call = (input: unknown) =>
      runtime.fetch(
        new Request('http://relanox.test/agents/grok/tools', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fixture-agent-credential',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(input)
        })
      )

    const claimed = z
      .object({ status: z.literal('claimed'), claimToken: z.string() })
      .parse(
        (await (
          await call({
            method: 'claim',
            requestId,
            claimKey: `claim:${requestId}`
          })
        ).json()) as unknown
      )

    const completed = await call({
      method: 'complete',
      requestId,
      claimToken: claimed.claimToken,
      resultId: `result:${requestId}`,
      text
    })

    return z
      .object({ status: z.literal('completed'), deliveryId: z.string() })
      .parse((await completed.json()) as unknown)
  }

  return { runtime, storage, filename, complete }
}
