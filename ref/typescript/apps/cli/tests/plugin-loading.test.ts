import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noopObservability } from '@relanox/sdk'
import { afterEach, expect, test } from 'vitest'
import { createPluginLoader } from '../src/plugin-loader.js'
import { validateApp } from '../src/runtime.js'
import { readConfig } from '../src/config.js'
import { cli } from './fixture.js'

const directories: string[] = []

const sqliteEntry = new URL(
  '../../../plugins/storage-sqlite/dist/plugin.js',
  import.meta.url
).href

afterEach(async () => {
  for (const temporary of directories.splice(0)) {
    await rm(temporary, { recursive: true, force: true })
  }
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'relanox-plugin-'))
  directories.push(path)
  return path
}

async function plugin(
  root: string,
  options: {
    kind?: string
    id?: string
    sdkMajor?: number
    entry?: string
    code?: string
  } = {}
): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/local-sqlite',
      version: '1.0.0',
      type: 'module',
      relanox: {
        kind: options.kind ?? 'storage',
        id: options.id ?? 'sqlite',
        sdkMajor: options.sdkMajor ?? 1,
        entry: options.entry ?? './plugin.js'
      }
    })
  )
  if (options.code !== undefined) {
    await writeFile(join(root, 'plugin.js'), options.code)
  }
}

// Protect package selection: eager evaluation or ignoring explicit precedence would
// Execute the unused throwing entry or miss the local marker. Earlier assembly
// Coverage only validated a distribution in which every official package existed.
test('an explicit development package wins over installed copies without executing unused plugins', async () => {
  const root = await directory()
  const local = join(root, 'local')
  const unused = join(root, 'unused')
  const installed = join(root, 'installed')
  const marker = join(root, 'local-loaded')
  await plugin(local, {
    code: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export { createPlugin } from ${JSON.stringify(sqliteEntry)}`
  })
  await plugin(unused, {
    kind: 'channel',
    id: 'discord',
    code: "throw new Error('unused plugin executed')"
  })
  await plugin(join(installed, 'node_modules/@relanox/storage-sqlite'), {
    code: "throw new Error('installed copy executed')"
  })
  const configPath = join(root, 'relay.json')
  await writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        directory: './installed',
        load: { paths: ['./local', './unused'] }
      },
      relay: {
        accounts: [],
        endpoints: [],
        bindings: [],
        storage: {
          plugin: 'sqlite',
          config: { filename: join(root, 'relay.sqlite') }
        },
        observability: { plugin: 'none', config: {} }
      }
    })
  )
  const config = await readConfig(configPath)
  expect(config.plugins?.directory).toBe(installed)
  expect(config.plugins?.load?.paths).toEqual([local, unused])
  const result = await cli(configPath, ['validate'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    accounts: 0,
    endpoints: 0
  })
  expect(await readFile(marker, 'utf8')).toBe('loaded')
  await expect(access(join(root, 'relay.sqlite'))).rejects.toThrow()
})

// Protect fail-closed override selection and pre-import metadata validation.
// A fallback or late SDK check can silently run the wrong implementation.
test('broken local overrides fail instead of loading an available official package', async () => {
  const root = await directory()
  await plugin(root)
  const loader = await createPluginLoader({ load: { paths: [root] } })
  await expect(loader.load('storage', 'sqlite')).rejects.toMatchObject({
    code: 'plugin_entry_missing'
  })
})

test('incompatible manifests are rejected before executing their entrypoints', async () => {
  const root = await directory()
  const marker = join(root, 'loaded')
  await plugin(root, {
    sdkMajor: 2,
    code: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded')`
  })
  await expect(
    createPluginLoader({ load: { paths: [root] } })
  ).rejects.toMatchObject({ code: 'plugin_manifest_invalid' })
  await expect(access(marker)).rejects.toThrow()
})

test('duplicate explicit overrides cannot select a plugin by incidental path order', async () => {
  const root = await directory()
  const first = join(root, 'one')
  const second = join(root, 'two')
  await plugin(first)
  await plugin(second)
  await expect(
    createPluginLoader({ load: { paths: [first, second] } })
  ).rejects.toMatchObject({ code: 'plugin_duplicate_override' })
})

// Manifest-controlled execution must stay within the package. Existing protocol
// Tests use trusted compiled entrypoints and cannot expose a traversal regression.
test('a manifest cannot import an entrypoint outside its package', async () => {
  const root = await directory()
  const marker = join(root, 'loaded')
  await writeFile(
    join(root, 'outside.js'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded')`
  )
  const local = join(root, 'local')
  await plugin(local, { entry: '../outside.js' })
  const loader = await createPluginLoader({ load: { paths: [local] } })
  await expect(loader.load('storage', 'sqlite')).rejects.toMatchObject({
    code: 'plugin_entry_outside_package'
  })
  await expect(access(marker)).rejects.toThrow()
})

// Registered npm package names may differ from the official name. A hard-coded
// Resolver would ignore the installer record. The fixture delegates all storage
// Behavior to the real production package rather than providing a mock store.
test('registered third-party package names resolve through the installed directory', async () => {
  const root = await directory()
  await plugin(join(root, 'node_modules/@fixture/local-sqlite'), {
    code: `export { createPlugin } from ${JSON.stringify(sqliteEntry)}`
  })
  await writeFile(
    join(root, 'relanox-plugins.json'),
    JSON.stringify({ 'storage:sqlite': '@fixture/local-sqlite' })
  )
  const loader = await createPluginLoader({ directory: root })
  const loaded = await loader.load('storage', 'sqlite')
  expect(loaded.kind).toBe('storage')
  if (loaded.kind !== 'storage') {
    throw new Error('storage required')
  }
  const filename = join(root, 'actual.sqlite')

  const database = await loaded.setup(
    loaded.validateConfig({ filename }),
    noopObservability
  )

  try {
    await database.initialize()
    expect(await database.health()).toMatchObject({ ok: true })
    await access(filename)
  } finally {
    await database.close()
  }
})

// The new middleware assembly must use the same local precedence as channels
// And storage. Registry unit tests exercise already supplied plugin instances,
// So they cannot detect a hard-coded Tencent import bypassing this resolver.
test('configured middleware uses the explicit local package and validates options without setup', async () => {
  const root = await directory()
  const marker = join(root, 'middleware-loaded')

  const entry = new URL(
    '../../../plugins/speech-tencent/dist/plugin.js',
    import.meta.url
  ).href

  await plugin(root, {
    kind: 'middleware',
    id: 'speech-tencent',
    code: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export { createPlugin } from ${JSON.stringify(entry)}`
  })

  const config = await validateApp({
    plugins: { load: { paths: [root] } },
    relay: {
      accounts: [],
      endpoints: [],
      bindings: [],
      storage: { plugin: 'sqlite', config: { filename: ':memory:' } },
      observability: { plugin: 'none', config: {} }
    },
    middleware: [
      {
        plugin: 'speech-tencent',
        config: {
          secretId: { env: 'PLUGIN_LOADING_ASR_ID' },
          secretKey: { env: 'PLUGIN_LOADING_ASR_KEY' }
        }
      }
    ]
  })

  expect(await readFile(marker, 'utf8')).toBe('loaded')
  expect(config.middleware).toEqual([
    {
      plugin: 'speech-tencent',
      config: {
        secretId: { env: 'PLUGIN_LOADING_ASR_ID' },
        secretKey: { env: 'PLUGIN_LOADING_ASR_KEY' },
        engine: '16k_zh'
      }
    }
  ])
})
