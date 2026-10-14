import { readPluginRegistry } from './plugin-registry.js'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SDK_MAJOR } from '@relanox/sdk'
import type {
  AgentPlugin,
  MiddlewarePlugin,
  ChannelPlugin,
  ObservabilityPlugin,
  StoragePlugin,
  PluginManifest
} from '@relanox/sdk'
import { z } from 'zod'
import type { PluginConfig } from './plugin-config.js'
import {
  PluginError,
  pluginEntry,
  readPluginPackage
} from './plugin-manifest.js'
import type { PluginPackage } from './plugin-manifest.js'

export type NativePlugin =
  | ChannelPlugin<unknown>
  | AgentPlugin<unknown>
  | MiddlewarePlugin<unknown>
  | StoragePlugin<unknown>
  | ObservabilityPlugin<unknown>

type Kind = PluginManifest['kind']

const callable = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === 'function'
)

const metadata = z.object({
  id: z.string(),
  sdkMajor: z.literal(SDK_MAJOR),
  runtime: z.literal('node'),
  validateConfig: callable,
  setup: callable
})

const contracts = {
  channel: metadata.extend({
    kind: z.literal('channel'),
    channel: z.string(),
    send: callable,
    capabilities: z.object({
      receive: z.literal(true),
      transport: z.enum(['http', 'connection', 'both']),
      maxTextLength: z.number().positive(),
      lengthUnit: z.enum(['utf16', 'codepoint', 'utf8']),
      idempotentSend: z.boolean()
    })
  }),
  agent: metadata.extend({
    kind: z.literal('agent'),
    agent: z.string(),
    dispatch: callable
  }),
  storage: metadata.extend({ kind: z.literal('storage') }),
  observability: metadata.extend({ kind: z.literal('observability') }),
  middleware: metadata.extend({ kind: z.literal('middleware') })
}

export function officialPackage(kind: Kind, id: string): string {
  return kind === 'middleware' ? `@relanox/${id}` : `@relanox/${kind}-${id}`
}

async function packageExists(root: string): Promise<boolean> {
  try {
    await access(resolve(root, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function installedPackage(
  directory: string | undefined,
  name: string
): Promise<PluginPackage> {
  if (directory) {
    const root = resolve(directory, 'node_modules', name)
    if (await packageExists(root)) {
      return readPluginPackage(root)
    }
  }
  // Supports workspace development and a deliberately assembled distribution.
  let entry: string
  try {
    entry = fileURLToPath(import.meta.resolve(name))
  } catch {
    throw new PluginError('plugin_not_installed', name)
  }
  let root = dirname(entry)
  while (!(await packageExists(root))) {
    const parent = dirname(root)
    if (parent === root) {
      throw new PluginError('plugin_manifest_missing', name)
    }
    root = parent
  }
  return readPluginPackage(root)
}

function verifyPlugin(value: unknown, kind: Kind, id: string): NativePlugin {
  if (!contracts[kind].safeParse(value).success) {
    throw new PluginError('plugin_contract_invalid', id)
  }
  const plugin = value as NativePlugin
  let identity = plugin.id
  if (plugin.kind === 'channel') {
    identity = plugin.channel
  }
  if (plugin.kind === 'agent') {
    identity = plugin.agent
  }
  if (plugin.kind === 'observability') {
    identity = plugin.id.replace(/^observability-/u, '')
  }
  if (identity !== id) {
    throw new PluginError('plugin_identity_mismatch', id)
  }
  return plugin
}

/** Explicit local packages override installed copies. Broken overrides never fall back. */
export async function createPluginLoader(config: PluginConfig = {}): Promise<{
  load(kind: Kind, id: string): Promise<NativePlugin>
}> {
  const overrides = new Map<string, PluginPackage>()
  for (const path of config.load?.paths ?? []) {
    const pkg = await readPluginPackage(resolve(path))
    const key = `${pkg.manifest.kind}:${pkg.manifest.id}`
    if (overrides.has(key)) {
      throw new PluginError('plugin_duplicate_override', pkg.manifest.id)
    }
    overrides.set(key, pkg)
  }

  const registry = config.directory
    ? await readPluginRegistry(config.directory)
    : {}

  const factories = new Map<string, () => unknown>()
  return {
    async load(kind, id) {
      const key = `${kind}:${id}`
      let factory = factories.get(key)
      if (!factory) {
        const pkg =
          overrides.get(key) ??
          (await installedPackage(
            config.directory,
            registry[key] ?? officialPackage(kind, id)
          ))

        if (pkg.manifest.kind !== kind || pkg.manifest.id !== id) {
          throw new PluginError('plugin_identity_mismatch', id)
        }
        const entry = await pluginEntry(pkg)
        let module: unknown
        try {
          module = await import(pathToFileURL(entry).href)
        } catch {
          throw new PluginError('plugin_import_failed', id)
        }

        const parsed = z
          .object({
            createPlugin: z.custom<() => unknown>(
              (value) => typeof value === 'function'
            )
          })
          .safeParse(module)

        if (!parsed.success) {
          throw new PluginError('plugin_factory_missing', id)
        }
        factory = parsed.data.createPlugin
        factories.set(key, factory)
      }
      return verifyPlugin(factory(), kind, id)
    }
  }
}
