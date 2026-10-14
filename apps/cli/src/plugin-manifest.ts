import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { SDK_MAJOR } from '@relanox/sdk'
import type { PluginManifest } from '@relanox/sdk'
import { z } from 'zod'

export class PluginError extends Error {
  constructor(
    readonly code: string,
    readonly plugin?: string
  ) {
    super(code)
    this.name = 'PluginError'
  }
}

const manifestSchema = z.strictObject({
  kind: z.enum(['channel', 'agent', 'storage', 'observability', 'middleware']),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  sdkMajor: z.literal(SDK_MAJOR),
  entry: z.string().min(1)
})

export type PluginPackage = {
  root: string
  manifest: PluginManifest
}

/** Manifest inspection never imports plugin code. */
export async function readPluginPackage(root: string): Promise<PluginPackage> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  } catch {
    throw new PluginError('plugin_manifest_missing')
  }
  const parsed = z.object({ relanox: manifestSchema }).safeParse(input)
  if (!parsed.success) {
    throw new PluginError('plugin_manifest_invalid')
  }
  return { root, manifest: parsed.data.relanox }
}

export async function pluginEntry(pkg: PluginPackage): Promise<string> {
  try {
    const root = await realpath(pkg.root)
    const entry = await realpath(resolve(root, pkg.manifest.entry))
    const child = relative(root, entry)
    if (
      isAbsolute(child) ||
      child === '..' ||
      child.startsWith('../') ||
      child.startsWith('..\\')
    ) {
      throw new PluginError('plugin_entry_outside_package', pkg.manifest.id)
    }
    return entry
  } catch (error) {
    if (error instanceof PluginError) {
      throw error
    }
    throw new PluginError('plugin_entry_missing', pkg.manifest.id)
  }
}
