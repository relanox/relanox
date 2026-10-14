import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'

const options = z
  .tuple([z.string().min(1), z.string()])
  .parse(process.argv.slice(2))

const [destination, selection] = options
const names = selection.split(/\s+/u).filter(Boolean)
for (const name of names) {
  if (
    !/^(?:channel|agent|storage|observability)-[a-z][a-z0-9-]*$/u.test(name)
  ) {
    throw new Error('invalid_native_plugin_package')
  }

  const result = spawnSync(
    'pnpm',
    [
      '--fail-if-no-match',
      '--filter',
      `@relanox/${name}`,
      'deploy',
      '--legacy',
      '--prod',
      resolve(destination, 'node_modules/@relanox', name)
    ],
    { stdio: 'inherit' }
  )

  if (result.error || result.status !== 0) {
    throw new Error('plugin_assembly_failed')
  }
}
