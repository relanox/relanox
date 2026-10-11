import { z } from 'zod'

export const workerSchema = z
  .strictObject({
    batchSize: z.number().int().min(1).max(1000).default(32),
    batchDurationMs: z.number().int().min(1).max(300_000).default(30_000),
    callTimeoutMs: z.number().int().min(1).max(120_000).default(10_000),
    leaseMs: z.number().int().min(1).max(300_000).default(30_000),
    maxAttempts: z.number().int().min(1).max(100).default(8),
    retryBaseMs: z.number().int().min(1).max(300_000).default(1000),
    retryMaxMs: z.number().int().min(1).max(3_600_000).default(300_000),
    maxTextBytes: z.number().int().min(1).max(16_777_216).default(1_048_576),
    maxMediaBytes: z.number().int().min(1).max(209_715_200).default(26_214_400),
    maxTotalMediaBytes: z
      .number()
      .int()
      .min(1)
      .max(209_715_200)
      .default(52_428_800),
    maxAttachments: z.number().int().min(1).max(10).default(10),
    maxContextBytes: z.number().int().min(1).max(1_048_576).default(65_536),
    maxHttpBodyBytes: z.number().int().min(1).max(16_777_216).default(2_097_152)
  })
  .superRefine((v, ctx) => {
    if (v.leaseMs <= v.callTimeoutMs || v.retryMaxMs < v.retryBaseMs) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Lease must exceed call timeout; retry maximum must exceed base'
      })
    }
  })

export type WorkerConfig = z.output<typeof workerSchema>
