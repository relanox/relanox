import { spawn } from 'node:child_process'
import { availablePort } from '../../../tests/listen.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { deadline } from '../src/deadline.js'
import { noopObservability } from '@relanox/sdk'
import type {
  RelanoxConfig,
  Storage,
  InboundSnapshot,
  IngestReceipt
} from '@relanox/sdk'
import { sqliteStoragePlugin } from '@relanox/storage-sqlite'

export async function fixture(): Promise<{
  directory: string
  filename: string
  configPath: string
  config: {
    relay: RelanoxConfig
    server: {
      port: number
      managementPort: number
    }
  }
  save(this: void, input?: unknown): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'relanox-cli-'))
  const filename = join(directory, 'relay.sqlite')
  const configPath = join(directory, 'relay.json')

  const relay: RelanoxConfig = {
    accounts: [],
    endpoints: [],
    bindings: [],
    storage: { plugin: 'sqlite', config: { filename } },
    observability: { plugin: 'none', config: {} }
  }

  const config = {
    relay,
    server: {
      port: await availablePort(),
      managementPort: await availablePort()
    }
  }

  const save = async (input: unknown = config): Promise<void> =>
    writeFile(configPath, JSON.stringify(input))

  await save()
  return { directory, filename, configPath, config, save }
}

export async function cli(
  path: string,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [entry, ...args, '--config', path],
        {
          windowsHide: true
        }
      )

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', reject)
      child.once('close', (code) => {
        resolve({ code, stdout, stderr })
      })
    }
  )
}

export async function storage(filename: string): Promise<Storage> {
  return sqliteStoragePlugin.setup(
    sqliteStoragePlugin.validateConfig({ filename }),
    noopObservability
  )
}

export async function runCli(path: string): Promise<{
  managementUrl: string
  stop(this: void): Promise<void>
}> {
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))

  const child = spawn(process.execPath, [entry, 'run', '--config', path], {
    windowsHide: true
  })

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve()
    })
  })

  const started = new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('\n')) {
        try {
          const value = z
            .object({ event: z.literal('started'), managementUrl: z.url() })
            .parse(JSON.parse(output.split('\n')[0] ?? ''))

          resolve(value.managementUrl)
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error('cli_invalid_startup_output')
          )
        }
      }
    })
    child.once('error', reject)
    child.once('close', () => {
      reject(new Error('cli_exited_before_startup'))
    })
  })

  async function stop(): Promise<void> {
    child.kill()
    await deadline(closed, 5000)
  }

  try {
    const managementUrl = await deadline(started, 5000)
    return { managementUrl, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/** A restored backlog was accepted under a real historical channel configuration. */
export async function seedInbound(
  database: Storage,
  snapshot: InboundSnapshot
): Promise<IngestReceipt> {
  await database.registerConversations([
    { address: snapshot.channel, endpoint: snapshot.endpoint }
  ])
  return database.acceptInbound(snapshot)
}
