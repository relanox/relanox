import { z } from 'zod'

export const workerSchema = z.strictObject({
  maxMediaBytes: z
    .number()
    .int()
    .min(1)
    .max(200 * 1024 * 1024)
    .default(100 * 1024 * 1024),
  maxTotalMediaBytes: z
    .number()
    .int()
    .min(1)
    .max(200 * 1024 * 1024)
    .default(100 * 1024 * 1024),
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
  maxTextBytes: 1024 * 1024,
  maxContextBytes: 64 * 1024,
  maxHttpBodyBytes: 2 * 1024 * 1024
}

export type WorkerConfig = z.output<typeof workerSchema> & typeof workerDefaults
