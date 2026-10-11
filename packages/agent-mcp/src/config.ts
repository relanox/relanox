import { z } from 'zod'

export const secretRef = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const mcpConfig = z.strictObject({
  token: secretRef,
  allowedOrigins: z.array(z.url()).default([])
})

export type McpConfig = z.infer<typeof mcpConfig>
