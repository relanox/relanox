import { tencentSpeechPlugin } from '@relanox/speech-tencent'
import { createMiddlewareRegistry } from './middleware-registry.js'

/** Add bundled middleware here; the config schema and loader are derived from this registry. */
export const middlewareRegistry = createMiddlewareRegistry([
  tencentSpeechPlugin
])
