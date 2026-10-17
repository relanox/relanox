import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PluginError } from './plugin-manifest.js'

const registrySchema = z.record(
  z.string(),
  z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu)
)

export async function readPluginRegistry(
  directory: string
): Promise<Record<string, string>> {
  let content: string
  try {
    content = await readFile(resolve(directory, 'relanox-plugins.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new PluginError('plugin_registry_invalid')
  }
  try {
    return registrySchema.parse(JSON.parse(content))
  } catch {
    throw new PluginError('plugin_registry_invalid')
  }
}

export async function registerInstalledPlugin(
  directory: string,
  key: string,
  name: string
): Promise<void> {
  const registry = await readPluginRegistry(directory)
  registry[key] = name
  const temporary = resolve(directory, `.relanox-plugins-${randomUUID()}.json`)
  await writeFile(temporary, JSON.stringify(registry, undefined, 2))
  await rename(temporary, resolve(directory, 'relanox-plugins.json'))
}
