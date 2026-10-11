import { readFile } from 'node:fs/promises'
import { appConfigSchema } from './config-schema.js'
import type { AppConfig } from './config-schema.js'

export { appConfigSchema } from './config-schema.js'
export type { AppConfig } from './config-schema.js'

/** File I/O and JSON decoding precede the application schema boundary. */
export async function readConfig(path: string): Promise<AppConfig> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'))
  return appConfigSchema.parse(input)
}
