import { validateMiddleware } from '@relanox/core'
import type { MessageMiddleware, MiddlewarePlugin } from '@relanox/sdk'
import { z } from 'zod'

type MiddlewareConfig = {
  readonly plugin: string
  readonly config: unknown
}

type MiddlewareRegistry = {
  readonly configSchema: z.ZodType<readonly MiddlewareConfig[]>
  setup(
    config: readonly MiddlewareConfig[]
  ): Promise<readonly MessageMiddleware[]>
}

/** Registered plugins own validation and setup; configuration alone selects and orders them. */
export function createMiddlewareRegistry(
  plugins: readonly MiddlewarePlugin<unknown>[]
): MiddlewareRegistry {
  validateMiddleware(plugins)
  const registered = new Map(plugins.map((plugin) => [plugin.id, plugin]))

  const get = (id: string): MiddlewarePlugin<unknown> => {
    const plugin = registered.get(id)
    if (!plugin) {
      throw new Error('unknown_middleware_plugin')
    }
    return plugin
  }

  const configSchema = z
    .array(
      z
        .strictObject({ plugin: z.string(), config: z.unknown() })
        .transform((entry) => ({
          plugin: entry.plugin,
          config: get(entry.plugin).validateConfig(entry.config)
        }))
    )
    .default([])
    .superRefine((entries) => {
      validateMiddleware(entries.map(({ plugin }) => ({ id: plugin })))
    })

  return {
    configSchema,
    async setup(config) {
      // Validate the whole list before any plugin can acquire resources.
      const entries = configSchema.parse(config)
      const middleware: MessageMiddleware[] = []
      for (const entry of entries) {
        const instance = await get(entry.plugin).setup(entry.config)
        if (instance.id !== entry.plugin) {
          throw new Error('middleware_identity_mismatch')
        }
        middleware.push(instance)
      }
      return middleware
    }
  }
}
