import { sqliteStoragePlugin } from './index.js'

export function createPlugin(): typeof sqliteStoragePlugin {
  return sqliteStoragePlugin
}
