import type { Observability, RelanoxConfig, Storage } from '@relanox/sdk'
import { noopObservability } from '@relanox/sdk'
import { postgresStoragePlugin } from '@relanox/storage-postgres'
import { sqliteStoragePlugin } from '@relanox/storage-sqlite'

export async function requireHealthy(storage: Storage): Promise<void> {
  if (!(await storage.health()).ok) {
    throw new Error('storage_unavailable')
  }
}

export function validateStorage(config: RelanoxConfig['storage']): void {
  if (config.plugin === 'sqlite') {
    sqliteStoragePlugin.validateConfig(config.config)
  } else {
    postgresStoragePlugin.validateConfig(config.config)
  }
}

export async function openStorage(
  config: RelanoxConfig['storage'],
  observe: Observability = noopObservability
): Promise<Storage> {
  if (config.plugin === 'sqlite') {
    return sqliteStoragePlugin.setup(
      sqliteStoragePlugin.validateConfig(config.config),
      observe
    )
  }
  return postgresStoragePlugin.setup(
    postgresStoragePlugin.validateConfig(config.config),
    observe
  )
}
