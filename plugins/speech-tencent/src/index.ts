import type { MiddlewarePlugin } from '@relanox/sdk'
import { configSchema } from './config.js'
import type { TencentSpeechConfig } from './config.js'
import { createSpeechMiddleware } from './middleware.js'

export { SpeechConfigurationError } from './config.js'
export type { TencentSpeechConfig } from './config.js'

export type {
  SpeechRecognition,
  SpeechTranscription,
  SpeechToTextProvider
} from './types.js'

/** Loading or validating the plugin does not load the cloud SDK or resolve credentials. */
export const tencentSpeechPlugin: MiddlewarePlugin<TencentSpeechConfig> = {
  id: 'speech-tencent',
  kind: 'middleware',
  sdkMajor: 1,
  runtime: 'node',
  validateConfig: (input) => configSchema.parse(input),
  async setup(config) {
    const { createTencentSpeechToText } = await import('./tencent.js')
    return createSpeechMiddleware(createTencentSpeechToText(config))
  }
}
