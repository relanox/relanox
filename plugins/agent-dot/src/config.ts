import { mcpConfig } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig.extend({ auth: z.literal('oauth').default('oauth') })
})

export type DotConfig = z.infer<typeof configSchema>
