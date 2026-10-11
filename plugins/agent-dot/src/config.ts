import { mcpConfig } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig.extend({ auth: z.enum(['bearer', 'oauth']).default('bearer') })
})

export type DotConfig = z.infer<typeof configSchema>
