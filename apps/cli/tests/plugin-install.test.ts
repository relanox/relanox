import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { npmCli } from '../src/npm.js'
import { cli, runCli } from './fixture.js'

const execute = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

async function fixture(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'relanox-install-'))
  directories.push(root)
  const configPath = join(root, 'relay.json')
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { directory: './installed' } })
  )
  return { root, configPath }
}

// Protect the actual CLI install -> registry -> load boundary. Existing tests
// Only had workspace packages, so they could pass with a broken installer or
// A resolver that required every plugin as a CLI dependency. The archive fixture
// Delegates storage to the real SQLite plugin and has no protocol/storage mock.
test('CLI installs a native archive with a lockfile and no lifecycle scripts before loading it', async () => {
  const { root, configPath } = await fixture()
  const source = join(root, 'package')
  const marker = join(root, 'lifecycle-ran')
  const filename = join(root, 'relay.sqlite')
  await mkdir(source)

  const entry = new URL(
    '../../../plugins/storage-sqlite/dist/plugin.js',
    import.meta.url
  ).href

  await writeFile(
    join(source, 'plugin.js'),
    `export { createPlugin } from ${JSON.stringify(entry)}`
  )
  await writeFile(
    join(source, 'lifecycle.js'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed')`
  )
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@fixture/installed-sqlite',
      version: '1.0.0',
      type: 'module',
      files: ['plugin.js', 'lifecycle.js'],
      scripts: { install: 'node lifecycle.js', prepare: 'node lifecycle.js' },
      relanox: {
        kind: 'storage',
        id: 'sqlite',
        sdkMajor: 1,
        entry: './plugin.js'
      }
    })
  )
  await execute(
    process.execPath,
    [
      await npmCli(),
      'pack',
      source,
      '--ignore-scripts',
      '--pack-destination',
      root
    ],
    { windowsHide: true }
  )

  const installed = await cli(configPath, [
    'plugins',
    'install',
    './fixture-installed-sqlite-1.0.0.tgz'
  ])

  expect(installed.code).toBe(0)
  expect(installed.stderr).toBe('')
  expect(JSON.parse(installed.stdout)).toMatchObject({
    ok: true,
    name: '@fixture/installed-sqlite',
    version: '1.0.0',
    directory: join(root, 'installed')
  })
  expect(
    JSON.parse(
      await readFile(join(root, 'installed/relanox-plugins.json'), 'utf8')
    )
  ).toEqual({ 'storage:sqlite': '@fixture/installed-sqlite' })
  await access(join(root, 'installed/package-lock.json'))
  await expect(access(marker)).rejects.toThrow()
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: { directory: './installed' },
      relay: {
        accounts: [],
        endpoints: [],
        bindings: [],
        storage: { plugin: 'sqlite', config: { filename } },
        observability: { plugin: 'none', config: {} }
      }
    })
  )
  const running = await runCli(configPath)
  try {
    await expect
      .poll(
        async () =>
          (await fetch(`${running.managementUrl}/health/ready`)).status
      )
      .toBe(200)
  } finally {
    await running.stop()
  }
  await access(filename)
  await expect(access(marker)).rejects.toThrow()
}, 30_000)

// Exact versions keep installs reproducible. A relaxed parser could turn an
// Upgrade into a moving dist-tag or another npm source; earlier tests never
// Invoked installation. No registry access or production-only test seam is used.
test.each([
  '@relanox/channel-telegram',
  '@relanox/channel-telegram@latest',
  'https://example.test/plugin.tgz',
  'git+https://example.test/plugin.git'
])('CLI rejects unpinned or unsupported install source %s', async (spec) => {
  const { root, configPath } = await fixture()
  const result = await cli(configPath, ['plugins', 'install', spec])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('plugin_install_requires_exact_version')
  await expect(access(join(root, 'installed'))).rejects.toThrow()
})
