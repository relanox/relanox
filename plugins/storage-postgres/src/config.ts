import { z } from 'zod'

export const configSchema = z
  .object({
    connectionString: z
      .object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) })
      .strict(),
    schema: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/u)
      .default('public'),
    maxConnections: z.number().int().min(1).max(100).default(10),
    connectionTimeoutMs: z.number().int().min(1).max(300_000).default(5000),
    idleTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    statementTimeoutMs: z.number().int().min(1).max(300_000).default(10_000)
  })
  .strict()

export type PostgresConfig = z.infer<typeof configSchema>
