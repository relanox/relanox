import { z } from 'zod'

export const secretRef = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const mcpConfig = z.strictObject({
  token: secretRef,
  allowedHosts: z.array(z.string().min(1).max(255)).min(1),
  allowedOrigins: z.array(z.url()).default([]),
  maxBodyBytes: z.number().int().min(1024).max(2_097_152).default(1_048_576),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000)
})

export type McpConfig = z.infer<typeof mcpConfig>

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  routineUrl: secretRef,
  routineAuthorization: secretRef,
  routineTransport: z.enum(['https', 'loopback-http']).default('https'),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  maxBodyBytes: z.number().int().min(1024).max(2_097_152).default(1_048_576)
})

export type GrokConfig = z.infer<typeof configSchema>
