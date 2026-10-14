import { postgresStoragePlugin } from './index.js'

export function createPlugin(): typeof postgresStoragePlugin {
  return postgresStoragePlugin
}
