import {
  validateConfig,
  validateMediaOptions,
  validatePublicDeployment
} from '@relanox/core'
import { validatePublicUrl } from '@relanox/sdk'
import { z } from 'zod'
import { tencentSpeechPlugin } from '@relanox/speech-tencent'

const port = z.number().int().min(0).max(65_535)

export const appConfigSchema = z
  .strictObject({
    publicUrl: z.string().transform(validatePublicUrl).optional(),
    relay: z.unknown().transform(validateConfig),
    speechToText: z
      .strictObject({
        plugin: z.literal('tencent'),
        config: z
          .unknown()
          .transform((input) => tencentSpeechPlugin.validateConfig(input))
      })
      .optional(),
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
  .superRefine((value) => {
    validatePublicDeployment(
      value.publicUrl,
      value.relay,
      value.media !== undefined
    )
  })

export type AppConfig = z.infer<typeof appConfigSchema>
