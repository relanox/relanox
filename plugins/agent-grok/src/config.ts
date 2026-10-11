import { mcpConfig, secretRef } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig.extend({ auth: z.enum(['bearer', 'path']).default('bearer') }),
  routineUrl: secretRef,
  routineAuthorization: secretRef
})

export type GrokConfig = z.infer<typeof configSchema>
