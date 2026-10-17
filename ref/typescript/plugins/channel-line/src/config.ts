import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(1024)

const configSchema = z.strictObject({
  channelSecret: secretRefSchema,
  accessToken: secretRefSchema
})

export type LineConfig = z.infer<typeof configSchema>

export function validateConfig(value: unknown): LineConfig {
  return configSchema.parse(value)
}
