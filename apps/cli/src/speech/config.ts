import { z } from 'zod'

const secretRef = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
})

export const speechToTextSchema = z.strictObject({
  provider: z.literal('tencent'),
  secretId: secretRef,
  secretKey: secretRef,
  engine: z
    .enum([
      '8k_zh',
      '8k_en',
      '16k_zh',
      '16k_zh-PY',
      '16k_zh_medical',
      '16k_en',
      '16k_yue',
      '16k_ja',
      '16k_ko',
      '16k_vi',
      '16k_ms',
      '16k_id',
      '16k_fil',
      '16k_th',
      '16k_pt',
      '16k_tr',
      '16k_ar',
      '16k_es',
      '16k_hi',
      '16k_fr',
      '16k_de',
      '16k_zh_dialect'
    ])
    .default('16k_zh')
})

export type SpeechToTextConfig = z.infer<typeof speechToTextSchema>

export class SpeechConfigurationError extends Error {
  readonly code = 'speech_credentials_missing'

  constructor() {
    super(
      'Tencent speechToText requires both configured SecretId and SecretKey environment variables'
    )
    this.name = 'SpeechConfigurationError'
  }
}

export function speechCredentials(config: SpeechToTextConfig): {
  secretId: string
  secretKey: string
} {
  const secretId = process.env[config.secretId.env]
  const secretKey = process.env[config.secretKey.env]
  if (!secretId?.trim() || !secretKey?.trim()) {
    throw new SpeechConfigurationError()
  }
  return { secretId, secretKey }
}
