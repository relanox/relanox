import { mcpConfig, secretRef } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  routineUrl: secretRef,
  routineAuthorization: secretRef
})

export type GrokConfig = z.infer<typeof configSchema>
