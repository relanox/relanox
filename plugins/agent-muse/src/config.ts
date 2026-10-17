import { mcpConfig, secretRef } from '@relanox/agent-mcp'
import { z } from 'zod'

export const configSchema = z.strictObject({
  mcp: mcpConfig.extend({ auth: z.enum(['bearer', 'path']).default('bearer') }),
  credentialsDirectory: secretRef,
  vmId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional()
})

export type MuseConfig = z.infer<typeof configSchema>
