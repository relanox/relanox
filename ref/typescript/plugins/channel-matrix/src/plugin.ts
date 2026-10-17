import { createMatrixChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createMatrixChannel> {
  return createMatrixChannel()
}
