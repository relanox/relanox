import { mcpConfig } from '@relanox/agent-mcp'
import { z } from 'zod'

export const callbackConfig = z.strictObject({
  allowedOrigins: z
    .array(z.url())
    .min(1)
    .max(100)
    .default(['https://connectors.api.openai.com']),
  transport: z.enum(['public-https', 'loopback-http']).default('public-https')
})

export type CallbackConfig = z.infer<typeof callbackConfig>

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  callback: callbackConfig.prefault({})
})

export type DotConfig = z.infer<typeof configSchema>
