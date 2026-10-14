import type { SpeechPlugin } from '@relanox/sdk'
import { configSchema } from './config.js'
import type { TencentSpeechConfig } from './config.js'

export { SpeechConfigurationError } from './config.js'
export type { TencentSpeechConfig } from './config.js'

/** Loading or validating the plugin does not load the cloud SDK or resolve credentials. */
export const tencentSpeechPlugin: SpeechPlugin<TencentSpeechConfig> = {
  id: 'tencent',
  kind: 'speech',
  sdkMajor: 1,
  runtime: 'node',
  validateConfig: (input) => configSchema.parse(input),
  async setup(config) {
    const { createTencentSpeechToText } = await import('./tencent.js')
    return createTencentSpeechToText(config)
  }
}
