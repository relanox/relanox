import { z } from 'zod'

export const workerSchema = z.strictObject({
  maxMediaBytes: z.number().int().min(1).max(209_715_200).default(26_214_400),
  maxTotalMediaBytes: z
    .number()
    .int()
    .min(1)
    .max(209_715_200)
    .default(52_428_800),
  maxAttachments: z.number().int().min(1).max(10).default(10)
})

export const workerDefaults = {
  batchSize: 32,
  batchDurationMs: 30_000,
  callTimeoutMs: 10_000,
  sendTimeoutMs: 600_000,
  sendLeaseMs: 630_000,
  leaseMs: 30_000,
  maxAttempts: 8,
  retryBaseMs: 1000,
  retryMaxMs: 300_000,
  maxTextBytes: 1_048_576,
  maxContextBytes: 65_536,
  maxHttpBodyBytes: 2_097_152
}

export type WorkerConfig = z.output<typeof workerSchema> & typeof workerDefaults
