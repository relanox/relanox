import { access, realpath } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import { PluginError } from './plugin-manifest.js'

/** Standard Node distributions bundle npm; resolve its JS CLI without a platform shell. */
export async function npmCli(): Promise<string> {
  const candidates = [
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(
      dirname(process.execPath),
      '../lib/node_modules/npm/bin/npm-cli.js'
    ),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => resolve(path, 'npm'))
  ]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      const entry = await realpath(candidate)
      if (entry.endsWith('.js')) {
        return entry
      }
    } catch {
      /* Try the next standard installation location. */
    }
  }
  throw new PluginError('plugin_install_npm_unavailable')
}
