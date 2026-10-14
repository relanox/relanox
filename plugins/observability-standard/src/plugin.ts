import { createStandardObservability } from './index.js'

export function createPlugin(): ReturnType<typeof createStandardObservability> {
  return createStandardObservability()
}
