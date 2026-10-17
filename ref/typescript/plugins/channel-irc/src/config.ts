import { z } from 'zod'

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const nicknameSchema = z
  .string()
  .regex(/^[A-Za-z_[\]\\`^{}|][A-Za-z0-9_[\]\\`^{}|-]{0,29}$/u)

export const channelSchema = z
  .string()
  .regex(/^[#&][^\s,:\0\r\n]{1,89}$/u)
  .refine((value) => Buffer.byteLength(value) <= 90)

const configSchema = z.strictObject({
  server: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:-]+$/u),
  port: z.number().int().min(1).max(65_535).default(6697),
  tls: z.boolean().default(true),
  allowInsecureLocalhost: z.boolean().default(false),
  nick: nicknameSchema,
  password: secretRefSchema.optional(),
  sasl: z
    .strictObject({
      username: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[^\0\r\n]+$/u),
      password: secretRefSchema
    })
    .optional(),
  allowNickFallback: z.boolean().default(false)
})

export type IrcConfig = z.infer<typeof configSchema>

export function validateConfig(value: unknown): IrcConfig {
  const config = configSchema.parse(value)
  if (
    !config.tls &&
    (!config.allowInsecureLocalhost ||
      !['localhost', '127.0.0.1', '::1'].includes(config.server))
  ) {
    throw new Error('tls_required')
  }
  return config
}
