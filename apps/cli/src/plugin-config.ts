import { dirname, resolve } from 'node:path'
import { z } from 'zod'

export const pluginConfigSchema = z.strictObject({
  directory: z.string().min(1).optional(),
  load: z.strictObject({ paths: z.array(z.string().min(1)) }).optional()
})

export type PluginConfig = z.infer<typeof pluginConfigSchema>

/** Relative paths belong to the configuration file, never the launch directory. */
export function resolvePluginConfig(
  input: unknown,
  configPath: string
): PluginConfig {
  const config = pluginConfigSchema.parse(input ?? {})
  const base = dirname(resolve(configPath))
  return {
    directory: resolve(base, config.directory ?? '.relanox/plugins'),
    ...(config.load
      ? {
          load: { paths: config.load.paths.map((path) => resolve(base, path)) }
        }
      : {})
  }
}
