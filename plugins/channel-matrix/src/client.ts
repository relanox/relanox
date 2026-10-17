import { MatrixClient, MemoryStore } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger.js'
import loglevel from 'loglevel'
import { requestTimeoutMs } from './constants.js'

// SDK diagnostics can contain event bodies and URLs. Report only adapter-owned
// Operational codes through ChannelHost instead of forwarding those diagnostics.
const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return logger
  }
}

export function matrixClient(
  baseUrl: string,
  accessToken: string,
  userId?: string,
  signal?: AbortSignal | (() => AbortSignal | undefined)
): MatrixClient {
  // Some SDK room/RTC helpers still use its shared logger instead of the client logger.
  const sdkLogger = loglevel.getLogger('matrix')
  sdkLogger.methodFactory = (): (() => void) => (): void => {}
  sdkLogger.rebuild()
  return new MatrixClient({
    baseUrl,
    accessToken,
    ...(userId ? { userId } : {}),
    logger,
    store: new MemoryStore(),
    localTimeoutMs: requestTimeoutMs,
    // Core owns delivery retries. Do not install the optional MatrixScheduler.
    async fetchFn(input, init) {
      const currentSignal = typeof signal === 'function' ? signal() : signal
      currentSignal?.throwIfAborted()
      return fetch(input, {
        ...init,
        redirect: 'error',
        ...(currentSignal
          ? {
              signal: init?.signal
                ? AbortSignal.any([currentSignal, init.signal])
                : currentSignal
            }
          : {})
      })
    }
  })
}
