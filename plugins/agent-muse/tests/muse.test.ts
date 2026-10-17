import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuseClient } from 'muse-client'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, mcp } from '../../agent-dot/tests/fixture.js'
import { createMuseAgentPlugin } from '../src/index.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
})

async function setup(): Promise<{
  fx: Awaited<ReturnType<typeof fixture>>
  plugin: ReturnType<typeof createMuseAgentPlugin>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-muse-'))
  cleanups.push(async () => rm(directory, { recursive: true, force: true }))
  // Official paired gadget file fields:
  // https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/src/musegadget/link_client.py
  // SDK credential contract: muse-client@0.1.0 src/credentials.ts (89a3feaeac8d18f912c33f621e5f59c300b87d36).
  await writeFile(
    join(directory, 'identity.json'),
    JSON.stringify({ mac: 'aa:bb:cc:dd:ee:ff' })
  )
  await writeFile(
    join(directory, 'pairing.json'),
    JSON.stringify({
      access_token: 'device-secret',
      refresh_token: 'refresh-secret'
    })
  )
  vi.stubEnv('MUSE_TEST_DIRECTORY', directory)
  vi.stubEnv('AGENT_TEST_TOKEN_0', 'secret-0')
  vi.stubEnv('AGENT_TEST_TOKEN_1', 'secret-1')

  const config = {
    mcp: mcp(),
    credentialsDirectory: { env: 'MUSE_TEST_DIRECTORY' },
    vmId: 'vm-123',
    sessionId: 'relanox-session'
  }

  const plugin = createMuseAgentPlugin()

  const fx = await fixture('muse', plugin, [
    config,
    { ...config, mcp: mcp('AGENT_TEST_TOKEN_1') }
  ])

  cleanups.push(fx.close)
  return { fx, plugin }
}

it('validates Muse configuration offline and requires secret references', () => {
  const plugin = createMuseAgentPlugin()
  expect(
    plugin.validateConfig({
      mcp: mcp(),
      credentialsDirectory: { env: 'MUSE_DIRECTORY' }
    })
  ).toMatchObject({ mcp: { auth: 'bearer' } })
  expect(() =>
    plugin.validateConfig({ mcp: mcp(), credentialsDirectory: '/secret/path' })
  ).toThrow()
  expect(() =>
    plugin.validateConfig({
      mcp: { ...mcp(), auth: 'oauth' },
      credentialsDirectory: { env: 'MUSE_DIRECTORY' }
    })
  ).toThrow()
})

it('authenticates MCP and scopes recovered incoming content to its endpoint', async () => {
  const { fx } = await setup()
  await fx.ingest(0, 'first private message', 'muse-first')
  await fx.ingest(1, 'second private message', 'muse-second')
  const client = await fx.client('secret-0')

  const result = await client.callTool({
    name: 'relanox_read_messages',
    arguments: {}
  })

  expect(JSON.stringify(result)).toContain('first private message')
  expect(JSON.stringify(result)).not.toContain('second private message')

  const unauthorized = await fx.core.fetch(
    new Request('https://relanox.test/agents/muse/mcp/endpoint0', {
      method: 'POST'
    })
  )

  expect(unauthorized.status).toBe(401)
})

it('sends projected notifications through the paired SDK and preserves uncertain acceptance', async () => {
  const { fx, plugin } = await setup()
  const receipt = await fx.ingest(0, 'native cloud question', 'muse-dispatch')
  const record = await fx.storage.getInbound(receipt.requestId)
  if (record === undefined) {
    throw new Error('missing_inbound')
  }

  // SDK boundary only: these assertions protect our invocation/projection, not Noise interoperability.
  const sendMessage = vi
    .fn()
    .mockResolvedValue({ messageId: 'native-message-id', raw: {} })

  const close = vi.fn()

  const connect = vi
    .spyOn(MuseClient, 'connect')
    .mockResolvedValue({ sendMessage, close } as unknown as MuseClient)

  const signal = new AbortController().signal
  expect(await plugin.dispatch({ request: record.snapshot, signal })).toEqual({
    status: 'accepted'
  })

  const credentialsMatcher: unknown = expect.objectContaining({
    accessToken: 'device-secret',
    deviceId: 'homelink-ddeeff'
  })

  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({
      vmId: 'vm-123',
      credentials: credentialsMatcher
    })
  )
  expect(sendMessage).toHaveBeenCalledWith(expect.any(String), {
    signal,
    sessionId: 'relanox-session'
  })
  const content: unknown = JSON.parse(String(sendMessage.mock.calls[0]?.[0]))
  expect(content).toMatchObject({
    requestId: receipt.requestId,
    text: 'native cloud question',
    source: { channel: { id: receipt.channel } }
  })
  expect(JSON.stringify(content)).not.toMatch(
    /device-secret|refresh-secret|privateTarget|credentialsDirectory/u
  )
  expect(close).toHaveBeenCalledOnce()
  sendMessage.mockRejectedValue(new Error('socket lost after acceptance'))
  expect(await plugin.dispatch({ request: record.snapshot, signal })).toEqual({
    status: 'unknown',
    errorCode: 'muse_trigger_uncertain'
  })
})

it('cancels a pending connection without sending and closes a late socket', async () => {
  const { fx, plugin } = await setup()
  const receipt = await fx.ingest(0, 'cancel this notification', 'muse-cancel')
  const record = await fx.storage.getInbound(receipt.requestId)
  if (record === undefined) {
    throw new Error('missing_inbound')
  }

  let connected: (client: MuseClient) => void = () => {}
  let started: () => void = () => {}

  const connecting = new Promise<void>((resolve) => {
    started = resolve
  })

  const pending = new Promise<MuseClient>((resolve) => {
    connected = resolve
  })

  vi.spyOn(MuseClient, 'connect').mockImplementation(async () => {
    started()
    return pending
  })
  const controller = new AbortController()

  const dispatching = plugin.dispatch({
    request: record.snapshot,
    signal: controller.signal
  })

  await connecting
  controller.abort()
  expect(await dispatching).toEqual({
    status: 'retryable',
    errorCode: 'muse_connect_failed'
  })
  const close = vi.fn()
  const sendMessage = vi.fn()
  connected({ close, sendMessage } as unknown as MuseClient)
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce()
  })
  expect(sendMessage).not.toHaveBeenCalled()
})
