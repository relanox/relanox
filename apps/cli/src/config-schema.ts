import { validateConfig, validateMediaOptions } from '@relanox/core'
import { z } from 'zod'

const port = z.number().int().min(0).max(65_535)

export const appConfigSchema = z
  .strictObject({
    relay: z.unknown().transform(validateConfig),
    media: z.unknown().transform(validateMediaOptions).optional(),
    mediaLimits: z
      .strictObject({
        maxMediaBytes: z
          .number()
          .int()
          .min(1)
          .max(209_715_200)
          .default(26_214_400),
        maxTotalMediaBytes: z
          .number()
          .int()
          .min(1)
          .max(209_715_200)
          .default(52_428_800),
        maxAttachments: z.number().int().min(1).max(10).default(10)
      })
      .optional(),
    server: z
      .strictObject({
        host: z.string().min(1).default('127.0.0.1'),
        port: port.default(8787),
        managementHost: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
        managementPort: port.default(8788),
        workerIntervalMs: z.number().int().min(10).max(60_000).default(1000),
        workerStaleMs: z.number().int().min(100).max(600_000).default(60_000),
        shutdownTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(120_000)
          .default(15_000),
        startupTimeoutMs: z.number().int().min(100).max(120_000).default(30_000)
      })
      .prefault({})
  })
  .superRefine((value, ctx) => {
    if (value.server.workerStaleMs <= value.server.workerIntervalMs) {
      ctx.addIssue({
        code: 'custom',
        message: 'Worker stale limit must exceed interval'
      })
    }
  })

export type AppConfig = z.infer<typeof appConfigSchema>
