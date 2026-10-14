import { tencentSpeechPlugin } from './index.js'

export function createPlugin(): typeof tencentSpeechPlugin {
  return tencentSpeechPlugin
}
