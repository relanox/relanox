import { npmCli } from './npm.js'
import { registerInstalledPlugin } from './plugin-registry.js'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { resolvePluginConfig } from './plugin-config.js'
import {
  PluginError,
  pluginEntry,
  readPluginPackage
} from './plugin-manifest.js'

const execute = promisify(execFile)

const pinnedPackage =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu

/** Installation is explicit; validate and run never contact a package registry. */
export async function installPlugin(
  configPath: string,
  spec: string
): Promise<{ name: string; version: string; directory: string }> {
  const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  const draft = z.object({ plugins: z.unknown().optional() }).parse(raw)
  const directory = resolvePluginConfig(draft.plugins, configPath).directory
  if (!directory) {
    throw new PluginError('plugin_directory_required')
  }

  const archive =
    spec.endsWith('.tgz') &&
    (isAbsolute(spec) ||
      spec.startsWith('./') ||
      spec.startsWith('../') ||
      spec.startsWith('.\\'))

  if (!pinnedPackage.test(spec) && !archive) {
    throw new PluginError('plugin_install_requires_exact_version')
  }
  const source = archive ? resolve(dirname(resolve(configPath)), spec) : spec
  await mkdir(directory, { recursive: true })
  try {
    await readFile(resolve(directory, 'package.json'))
  } catch {
    await writeFile(
      resolve(directory, 'package.json'),
      JSON.stringify({
        name: 'relanox-installed-plugins',
        private: true,
        type: 'module'
      })
    )
  }

  const npm = await npmCli()

  const packed = await execute(
    process.execPath,
    [
      npm,
      'pack',
      source,
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      directory
    ],
    { windowsHide: true, timeout: 120_000 }
  )

  const [metadata] = z
    .array(
      z.object({
        name: z
          .string()
          .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu),
        version: z.string(),
        filename: z.string().regex(/^[a-z0-9@._-]+\.tgz$/iu)
      })
    )
    .length(1)
    .parse(JSON.parse(packed.stdout))

  if (!metadata) {
    throw new PluginError('plugin_install_invalid_package')
  }
  await execute(
    process.execPath,
    [
      npm,
      'install',
      '--prefix',
      directory,
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--',
      archive ? resolve(directory, metadata.filename) : source
    ],
    { windowsHide: true, timeout: 120_000 }
  )

  const pkg = await readPluginPackage(
    resolve(directory, 'node_modules', metadata.name)
  )

  await pluginEntry(pkg)
  await registerInstalledPlugin(
    directory,
    `${pkg.manifest.kind}:${pkg.manifest.id}`,
    metadata.name
  )
  return { name: metadata.name, version: metadata.version, directory }
}
