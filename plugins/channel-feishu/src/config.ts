import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(256)

const configSchema = z.strictObject({
  appId: platformIdSchema,
  appSecret: secretRefSchema,
  verificationToken: secretRefSchema,
  encryptKey: secretRefSchema,
  tenantKey: platformIdSchema,
  domain: z.enum(['feishu', 'lark']).default('feishu')
})

export type FeishuConfig = z.infer<typeof configSchema>

export function validateConfig(input: unknown): FeishuConfig {
  const parsed = configSchema.parse(input)
  return parsed
}

export const REQUEST_TIMEOUT_MS = 10_000
