import { z } from 'zod'

export const configSchema = z
  .object({
    filename: z.string().min(1)
  })
  .strict()

export type SqliteConfig = z.infer<typeof configSchema>
