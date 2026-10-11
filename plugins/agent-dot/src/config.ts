import { mcpConfig } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig
})

export type DotConfig = z.infer<typeof configSchema>
