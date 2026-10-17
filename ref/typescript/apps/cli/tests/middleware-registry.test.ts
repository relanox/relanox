import { expect, it } from 'vitest'
import { z } from 'zod'
import type { MiddlewarePlugin } from '@relanox/sdk'
import { createMiddlewareRegistry } from '../src/middleware-registry.js'
import { middlewareFixture } from '../../../tests/core/middleware-fixture.js'
import { incoming } from '../../../tests/core/fixture.js'

function textPlugin(
  id: string,
  setupCalls: string[]
): MiddlewarePlugin<{ prefix: string }> {
  return {
    id,
    kind: 'middleware',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: (input) =>
      z.strictObject({ prefix: z.string().default('default:') }).parse(input),
    async setup(config) {
      setupCalls.push(id)
      return {
        id,
        plan: () => config.prefix,
        async process({ message, options }) {
          return { text: `${z.string().parse(options)}${message.text}` }
        }
      }
    }
  }
}

it('selects registered non-speech plugins from configuration, validates their options and executes in user order', async () => {
  const calls: string[] = []

  const registry = createMiddlewareRegistry([
    textPlugin('first', calls),
    textPlugin('second', calls),
    textPlugin('disabled', calls)
  ])

  const config = registry.configSchema.parse([
    { plugin: 'second', config: { prefix: 'B:' } },
    { plugin: 'first', config: {} }
  ])

  expect(config).toEqual([
    { plugin: 'second', config: { prefix: 'B:' } },
    { plugin: 'first', config: { prefix: 'default:' } }
  ])
  expect(calls).toEqual([])
  const middleware = await registry.setup(config)
  expect(calls).toEqual(['second', 'first'])
  const fx = await middlewareFixture(middleware)
  try {
    await fx.channel.ingest({ ...incoming, text: 'original' })
    await fx.runtime.processDue()
    expect(fx.dispatched[0]?.text).toBe('default:B:original')
  } finally {
    await fx.close()
  }
  expect(await registry.setup([])).toEqual([])
  expect(calls).toEqual(['second', 'first'])
})

it.each([
  { name: 'unknown plugin', entries: [{ plugin: 'unknown', config: {} }] },
  {
    name: 'duplicate plugin',
    entries: [
      { plugin: 'first', config: {} },
      { plugin: 'first', config: {} }
    ]
  },
  {
    name: 'invalid later options',
    entries: [
      { plugin: 'first', config: {} },
      { plugin: 'second', config: { prefix: 123 } }
    ]
  }
])('rejects $name before setting up any middleware', async ({ entries }) => {
  const calls: string[] = []

  const registry = createMiddlewareRegistry([
    textPlugin('first', calls),
    textPlugin('second', calls)
  ])

  await expect(registry.setup(entries)).rejects.toThrow()
  expect(calls).toEqual([])
})

it('rejects ambiguous registration and a runtime identity that differs from its configured plugin', async () => {
  const calls: string[] = []
  const plugin = textPlugin('first', calls)
  expect(() => createMiddlewareRegistry([plugin, plugin])).toThrow(
    'invalid_middleware_configuration'
  )

  const mismatched: MiddlewarePlugin<{ prefix: string }> = {
    ...plugin,
    async setup(config) {
      return { ...(await plugin.setup(config)), id: 'wrong' }
    }
  }

  const registry = createMiddlewareRegistry([mismatched])

  await expect(
    registry.setup([{ plugin: 'first', config: {} }])
  ).rejects.toThrow('middleware_identity_mismatch')
})

it('runs every registered middleware in a longer configured chain', async () => {
  const calls: string[] = []

  const plugins = Array.from({ length: 17 }, (_, index) =>
    textPlugin(`step-${index}`, calls)
  )

  const registry = createMiddlewareRegistry(plugins)

  const middleware = await registry.setup(
    plugins.map((plugin, index) => ({
      plugin: plugin.id,
      config: { prefix: `${index}:` }
    }))
  )

  const fx = await middlewareFixture(middleware)
  try {
    await fx.channel.ingest({ ...incoming, text: 'original' })
    await fx.runtime.processDue()
    expect(fx.dispatched[0]?.text).toBe(
      '16:15:14:13:12:11:10:9:8:7:6:5:4:3:2:1:0:original'
    )
  } finally {
    await fx.close()
  }
})
