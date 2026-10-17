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
import { createPluginLoader } from '../src/plugin-loader.js'
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

async function nativeArchive(
  root: string,
  packageName: string,
  kind: string,
  id: string,
  nativePackage: string
): Promise<string> {
  const source = join(root, packageName)
  await mkdir(source)

  const entry = new URL(
    `../../../plugins/${nativePackage}/dist/plugin.js`,
    import.meta.url
  ).href

  await writeFile(
    join(source, 'plugin.js'),
    `export { createPlugin } from ${JSON.stringify(entry)}`
  )
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: `@fixture/${packageName}`,
      version: '1.0.0',
      type: 'module',
      files: ['plugin.js'],
      relanox: { kind, id, sdkMajor: 1, entry: './plugin.js' }
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
  return `./fixture-${packageName}-1.0.0.tgz`
}

// Two actual CLI processes share npm's manifest, lockfile and Relanox registry.
// Sequential archive tests cannot expose lost updates between these operations.
// These archives re-export real native plugins; no persistence or npm mocks are used.
test('concurrent CLI installs preserve both native packages and registry entries', async () => {
  const { root, configPath } = await fixture()

  const first = await nativeArchive(
    root,
    'concurrent-sqlite',
    'storage',
    'sqlite',
    'storage-sqlite'
  )

  const second = await nativeArchive(
    root,
    'concurrent-observe',
    'observability',
    'standard',
    'observability-standard'
  )

  const outcomes = await Promise.all([
    cli(configPath, ['plugins', 'install', first]),
    cli(configPath, ['plugins', 'install', second])
  ])

  expect(
    outcomes.map((result) => ({ code: result.code, stderr: result.stderr }))
  ).toEqual([
    { code: 0, stderr: '' },
    { code: 0, stderr: '' }
  ])
  const directory = join(root, 'installed')
  expect(
    JSON.parse(await readFile(join(directory, 'relanox-plugins.json'), 'utf8'))
  ).toEqual({
    'storage:sqlite': '@fixture/concurrent-sqlite',
    'observability:standard': '@fixture/concurrent-observe'
  })
  expect(
    JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  ).toMatchObject({
    dependencies: {
      '@fixture/concurrent-sqlite': 'file:fixture-concurrent-sqlite-1.0.0.tgz',
      '@fixture/concurrent-observe': 'file:fixture-concurrent-observe-1.0.0.tgz'
    }
  })
  expect(
    JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
  ).toMatchObject({
    packages: {
      'node_modules/@fixture/concurrent-sqlite': { version: '1.0.0' },
      'node_modules/@fixture/concurrent-observe': { version: '1.0.0' }
    }
  })
  const loader = await createPluginLoader({ directory })
  expect((await loader.load('storage', 'sqlite')).kind).toBe('storage')
  expect((await loader.load('observability', 'standard')).kind).toBe(
    'observability'
  )
}, 30_000)

// A failed npm operation must release the same cross-process installation lock.
// Otherwise the live owner keeps refreshing its lock and blocks the next install.
// Exercise the CLI's real install function twice in a bounded child process.
test('a failed archive install releases the directory for the next installation', async () => {
  const { root, configPath } = await fixture()

  const archive = await nativeArchive(
    root,
    'after-failure',
    'storage',
    'sqlite',
    'storage-sqlite'
  )

  const entry = new URL('../dist/plugin-install.js', import.meta.url).href

  const program = `
    import { installPlugin } from ${JSON.stringify(entry)};
    let rejected = false;
    try { await installPlugin(${JSON.stringify(configPath)}, './missing-plugin.tgz'); }
    catch { rejected = true; }
    const installed = await installPlugin(${JSON.stringify(configPath)}, ${JSON.stringify(archive)});
    console.log(JSON.stringify({ rejected, installed }));
  `

  const installed = await execute(
    process.execPath,
    ['--input-type=module', '-e', program],
    { windowsHide: true, timeout: 20_000 }
  )

  expect(installed.stderr).toBe('')
  expect(JSON.parse(installed.stdout)).toMatchObject({
    rejected: true,
    installed: { name: '@fixture/after-failure', version: '1.0.0' }
  })
  expect(
    JSON.parse(
      await readFile(join(root, 'installed/relanox-plugins.json'), 'utf8')
    )
  ).toEqual({
    'storage:sqlite': '@fixture/after-failure'
  })
}, 30_000)

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
