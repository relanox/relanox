import { mcpConfig } from '@relanox/agent-mcp'
import { z } from 'zod'

export const callbackConfig = z.strictObject({
  allowedOrigins: z.array(z.url()).min(1).max(100),
  transport: z.enum(['public-https', 'loopback-http']).default('public-https'),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000)
})

export type CallbackConfig = z.infer<typeof callbackConfig>

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  callback: callbackConfig,
  subscriptionTtlMs: z
    .number()
    .int()
    .min(1000)
    .max(604_800_000)
    .default(86_400_000),
  rotationWindowMs: z.number().int().min(1000).max(300_000).default(60_000)
})

export type DotConfig = z.infer<typeof configSchema>
