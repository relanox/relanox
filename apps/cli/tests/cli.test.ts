import type { RelanoxConfig } from '@relanox/sdk'
import { createServer } from 'node:http'
import { access, rm } from 'node:fs/promises'
import { afterEach, expect, test, vi } from 'vitest'
import { startRuntime } from '../src/runtime.js'
import { closeServer, listen } from '../src/listeners.js'
import { snapshot } from '../../../tests/contracts/storage-contract.js'
import { cli, fixture, storage, runCli } from './fixture.js'

const directories: string[] = []
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(stops.splice(0).map(async (stop) => stop()))
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  )
})

test('assembled Telegram ingress persists before ACK and status projects only opted-in text', async () => {
  const value = await setup()

  const relay = {
    ...value.config.relay,
    accounts: [
      {
        id: 'telegram-bot',
        channel: 'telegram',
        allowedSenders: ['17'],
        config: {
          botToken: { env: 'CLI_TEST_BOT_TOKEN' },
          webhookSecret: { env: 'CLI_TEST_WEBHOOK_SECRET' }
        }
      }
    ],
    endpoints: [
      {
        id: 'grok-main',
        agent: 'grok',
        config: {
          mcp: {
            token: { env: 'CLI_TEST_AGENT_TOKEN' }
          },
          routineUrl: { env: 'CLI_TEST_ROUTINE_URL' },
          routineAuthorization: { env: 'CLI_TEST_ROUTINE_AUTH' }
        }
      }
    ],
    bindings: [
      { accountId: 'telegram-bot', chatId: '22', endpointId: 'grok-main' }
    ]
  }

  const config = { ...value.config, publicUrl: 'https://relay.example', relay }
  await value.save(config)
  vi.stubEnv('CLI_TEST_BOT_TOKEN', '123:valid-token')
  vi.stubEnv('CLI_TEST_WEBHOOK_SECRET', 'valid-webhook-secret')
  const runtime = await startRuntime(config)
  stops.push(runtime.stop)

  const response = await fetch(
    `${runtime.businessUrl}/channels/telegram-bot/webhook`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'valid-webhook-secret'
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 8,
          chat: { id: 22, type: 'private' },
          from: { id: 17, is_bot: false },
          text: 'confidential incoming message'
        }
      })
    }
  )

  expect(response.status).toBe(204)
  await expect
    .poll(
      async () => (await runtime.core.status()).requests[0]?.dispatch.status,
      { timeout: 5000 }
    )
    .toBe('rejected')
  const plain = await cli(value.configPath, ['status'])
  expect(plain.code).toBe(0)
  expect(JSON.parse(plain.stdout)).toMatchObject({
    stats: { pending: 0 },
    requests: [
      {
        endpointId: 'grok-main',
        accountId: 'telegram-bot',
        dispatch: { status: 'rejected' }
      }
    ]
  })
  expect(plain.stdout).not.toContain('confidential incoming message')
  expect(plain.stdout).not.toContain('CLI_TEST_AGENT_TOKEN')
  expect(plain.stdout).not.toContain('valid-token')
  const content = await cli(value.configPath, ['status', '--include-content'])
  expect(content.code).toBe(0)
  expect(JSON.parse(content.stdout)).toMatchObject({
    requests: [{ text: 'confidential incoming message' }]
  })
  expect(content.stdout).not.toContain('CLI_TEST_AGENT_TOKEN')
  expect(content.stdout).not.toContain('claimToken')
})

test('requeue passes exact version and explicit unknown-effect acknowledgement into actual storage', async () => {
  const value = await setup()
  const db = await storage(value.filename)
  try {
    await db.initialize()
    await db.acceptInbound({
      requestId: 'unknown-request',
      source: { channel: 'telegram', accountId: 'bot', eventId: 'event' },
      senderId: 'sender',
      text: 'secret source text',
      target: {
        channel: 'telegram',
        accountId: 'bot',
        chatId: 'chat',
        data: null
      },
      receivedAt: 1,
      context: null,
      acceptedAt: 1,
      endpoint: {
        id: 'endpoint',
        agent: 'grok',
        config: {}
      }
    })

    const [work] = await db.takeDue({
      now: 2,
      leaseMs: 1000,
      limit: 1,
      leaseOwner: 'operator',
      safeRetryAccountIds: []
    })

    if (work?.kind !== 'dispatch') {
      throw new Error('Expected real due dispatch')
    }
    expect(
      await db.settleAttempt({
        kind: 'dispatch',
        id: 'unknown-request',
        lease: work.lease,
        outcome: { status: 'unknown', errorCode: 'network' },
        nextDueAt: 3,
        now: 3
      })
    ).toMatchObject({ status: 'updated' })
    const held = await db.getInbound('unknown-request')
    if (!held) {
      throw new Error('Expected persisted unknown request')
    }

    const base = [
      'requeue',
      '--kind',
      'request',
      '--id',
      'unknown-request',
      '--expected-version',
      String(held.version)
    ]

    const unacknowledged = await cli(value.configPath, base)
    expect(unacknowledged.code).toBe(2)
    expect(JSON.parse(unacknowledged.stdout)).toEqual({ status: 'conflict' })

    const stale = await cli(value.configPath, [
      'requeue',
      '--kind',
      'request',
      '--id',
      'unknown-request',
      '--expected-version',
      '1',
      '--acknowledge-unknown'
    ])

    expect(stale.code).toBe(2)
    expect(JSON.parse(stale.stdout)).toEqual({ status: 'conflict' })

    const recovered = await cli(value.configPath, [
      ...base,
      '--acknowledge-unknown'
    ])

    expect(recovered.code).toBe(0)
    expect(JSON.parse(recovered.stdout)).toEqual({
      status: 'updated',
      version: held.version + 1
    })
    expect(await db.getInbound('unknown-request')).toMatchObject({
      dispatch: { status: 'due', attempts: 0 },
      version: held.version + 1
    })
  } finally {
    await db.close()
  }
})

async function setup(): Promise<{
  directory: string
  filename: string
  configPath: string
  config: {
    relay: RelanoxConfig
    server: {
      port: number
      managementPort: number
    }
  }
  save(this: void, input?: unknown): Promise<void>
}> {
  const value = await fixture()
  directories.push(value.directory)
  return value
}

test('validate has no database side effects and redacts malformed configuration errors', async () => {
  const value = await setup()
  const validated = await cli(value.configPath, ['validate'])
  expect(validated.code).toBe(0)
  expect(JSON.parse(validated.stdout)).toEqual({
    ok: true,
    accounts: 0,
    endpoints: 0
  })
  await expect(access(value.filename)).rejects.toThrow()
  await value.save({
    ...value.config,
    secretCredential: 'must-never-print-credential'
  })
  const rejected = await cli(value.configPath, ['validate'])
  expect(rejected.code).toBe(1)
  expect(rejected.stderr).toBe('{"ok":false,"errorCode":"command_failed"}\n')
  expect(rejected.stdout).toBe('')
  await expect(access(value.filename)).rejects.toThrow()
})

test('validate rejects public management addresses before opening storage', async () => {
  const value = await setup()
  await value.save({ ...value.config, server: { managementHost: '0.0.0.0' } })
  expect((await cli(value.configPath, ['validate'])).code).toBe(1)
  await expect(access(value.filename)).rejects.toThrow()
})

test('validate identifies a missing public URL for hosted protocols before opening storage', async () => {
  const value = await setup()
  for (const required of [
    {
      relay: {
        ...value.config.relay,
        endpoints: [
          {
            id: 'grok',
            agent: 'grok',
            config: {
              mcp: { token: { env: 'CLI_AGENT_TOKEN' } },
              routineUrl: { env: 'CLI_ROUTINE_URL' },
              routineAuthorization: { env: 'CLI_ROUTINE_AUTH' }
            }
          }
        ]
      }
    },
    {
      relay: {
        ...value.config.relay,
        accounts: [
          {
            id: 'chat',
            channel: 'googlechat',
            config: { serviceAccount: { env: 'CLI_CHAT_SERVICE' } },
            allowedSenders: ['users/alice']
          }
        ]
      }
    },
    { media: { urlLifetimeMs: 1000 } }
  ]) {
    await value.save({ ...value.config, ...required })
    const result = await cli(value.configPath, ['validate'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      errorCode: 'public_url_required'
    })
    await expect(access(value.filename)).rejects.toThrow()
  }
})

test('validates native media publication and byte limits before opening storage', async () => {
  const value = await setup()
  await value.save({
    ...value.config,
    publicUrl: 'https://media.example.org',
    media: {
      urlLifetimeMs: 60_000
    },
    mediaLimits: {
      maxMediaBytes: 1024,
      maxTotalMediaBytes: 2048,
      maxAttachments: 2
    }
  })
  expect((await cli(value.configPath, ['validate'])).code).toBe(0)
  for (const options of [
    { publicUrl: 'http://media.example.org' },
    { publicUrl: 'https://media.example.org/private' },
    { publicUrl: 'https://media.example.org:99999' },
    { publicUrl: 'https://@media.example.org' },
    { publicUrl: 'http://localhost:8787' },
    { media: { publicBaseUrl: 'https://media.example.org' } },
    { mediaLimits: { maxMediaBytes: 209_715_201 } },
    { mediaLimits: { maxAttachments: 11 } }
  ]) {
    await value.save({ ...value.config, ...options })
    const rejected = await cli(value.configPath, ['validate'])
    expect(rejected.code).toBe(1)
    if ('publicUrl' in options) {
      expect(JSON.parse(rejected.stderr)).toEqual({
        ok: false,
        errorCode: 'invalid_public_url'
      })
    }
  }
  await expect(access(value.filename)).rejects.toThrow()
})

test('run initializes a new database and preserves work on restart while diagnosis stays read-only', async () => {
  const value = await setup()
  const doctor = await cli(value.configPath, ['doctor'])
  expect(doctor.code).toBe(2)
  expect(JSON.parse(doctor.stdout)).toMatchObject({
    ok: false,
    storage: { ok: false }
  })
  expect((await cli(value.configPath, ['status'])).code).toBe(1)
  const empty = await storage(value.filename)
  expect(await empty.health()).toEqual({
    ok: false,
    errorCode: 'storage_unavailable'
  })
  await empty.close()
  const first = await runCli(value.configPath)
  stops.push(first.stop)
  expect((await fetch(`${first.managementUrl}/health/ready`)).status).toBe(200)
  await first.stop()
  const db = await storage(value.filename)
  await db.acceptInbound({
    ...snapshot(),
    endpoint: { id: 'ep', agent: 'grok', config: {} }
  })
  await db.close()
  const second = await runCli(value.configPath)
  stops.push(second.stop)
  expect((await fetch(`${second.managementUrl}/health/ready`)).status).toBe(200)
  const healthy = await cli(value.configPath, ['doctor'])
  expect(healthy.code).toBe(0)
  expect(JSON.parse(healthy.stdout)).toMatchObject({
    ok: true,
    storage: { ok: true }
  })
  const persisted = await cli(value.configPath, ['status', '--include-content'])
  expect(persisted.code).toBe(0)
  expect(JSON.parse(persisted.stdout)).toMatchObject({
    requests: [{ requestId: 'r1', text: 'question' }]
  })
})

test('real listeners isolate management endpoints and release both ports on shutdown', async () => {
  const value = await setup()

  const input = {
    ...value.config,
    relay: {
      ...value.config.relay,
      observability: {
        plugin: 'standard',
        config: { logs: false, metrics: true }
      }
    }
  }

  const runtime = await startRuntime(input)
  stops.push(runtime.stop)
  for (const path of ['/health/live', '/health/ready', '/metrics']) {
    expect((await fetch(`${runtime.businessUrl}${path}`)).status).toBe(404)
    expect((await fetch(`${runtime.managementUrl}${path}`)).status).toBe(200)
  }
  expect(
    await (await fetch(`${runtime.managementUrl}/health/ready`)).json()
  ).toEqual({ ok: true })
  expect(
    await (await fetch(`${runtime.managementUrl}/metrics`)).text()
  ).toContain('relanox_worker_last_success_timestamp_seconds')

  const doctor = await cli(value.configPath, [
    'doctor',
    '--management-url',
    runtime.managementUrl
  ])

  expect(doctor.code).toBe(0)
  await runtime.stop()
  await runtime.stop()
  for (const origin of [runtime.businessUrl, runtime.managementUrl]) {
    const server = createServer()
    const port = Number(new URL(origin).port)
    expect(await listen(server, port, '127.0.0.1')).toBe(origin)
    await closeServer(server)
  }
})

test('a failed second listener cleans up the first listener and storage', async () => {
  const value = await setup()
  const busy = createServer()
  const busyUrl = await listen(busy, 0, '127.0.0.1')
  stops.push(async () => closeServer(busy))
  const probe = createServer()
  const businessUrl = await listen(probe, 0, '127.0.0.1')
  await closeServer(probe)
  await expect(
    startRuntime({
      ...value.config,
      server: {
        port: Number(new URL(businessUrl).port),
        managementPort: Number(new URL(busyUrl).port)
      }
    })
  ).rejects.toThrow()
  const rebound = createServer()
  expect(
    await listen(rebound, Number(new URL(businessUrl).port), '127.0.0.1')
  ).toBe(businessUrl)
  await closeServer(rebound)
  const reopened = await storage(value.filename)
  expect(await reopened.health()).toEqual({ ok: true })
  await reopened.close()
})
