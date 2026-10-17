import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const platformIdSchema = z.string().min(1).max(256)

const common = {
  botToken: secretRefSchema,
  appId: platformIdSchema
}

const configSchema = z.union([
  z.strictObject({
    ...common,
    signingSecret: secretRefSchema
  }),
  z.strictObject({
    ...common,
    appToken: secretRefSchema
  })
])

export type SlackConfig = z.infer<typeof configSchema>

export function validateConfig(input: unknown): SlackConfig {
  const parsed = configSchema.parse(input)
  return parsed
}

export const REQUEST_TIMEOUT_MS = 10_000

export const API_BASE_URL = 'https://slack.com/api'
