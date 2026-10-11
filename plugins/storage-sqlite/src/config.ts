import { z } from 'zod'

export const configSchema = z
  .object({
    filename: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5000)
  })
  .strict()

export type SqliteConfig = z.infer<typeof configSchema>
