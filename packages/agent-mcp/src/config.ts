import { z } from 'zod'

export const secretRef = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const mcpConfig = z.strictObject({
  token: secretRef,
  allowedHosts: z.array(z.string().min(1).max(255)).min(1),
  allowedOrigins: z.array(z.url()).default([])
})

export type McpConfig = z.infer<typeof mcpConfig>
