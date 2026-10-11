import type { RelanoxConfig } from '@relanox/sdk'
import { configShapeSchema } from './schema.js'
import { validateConfigRelations } from './relations.js'

export { channels } from './schema.js'
export { bindingKey } from './relations.js'
export { validatePublicDeployment } from '../public-url.js'

export const configSchema = configShapeSchema.superRefine(
  validateConfigRelations
)

/** Parse untrusted configuration before plugin validation or resource acquisition. */
export function validateConfig(input: unknown): RelanoxConfig {
  return configSchema.parse(input) as RelanoxConfig
}
