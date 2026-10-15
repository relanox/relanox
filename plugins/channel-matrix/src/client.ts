import { MatrixClient, MemoryStore } from 'matrix-js-sdk'
import type { Logger } from 'matrix-js-sdk/lib/logger.js'
import type { RoomMessageTextEventContent } from 'matrix-js-sdk/lib/@types/events.js'
import type { MediaEventContent } from 'matrix-js-sdk/lib/@types/media.js'
import loglevel from 'loglevel'
import { requestTimeoutMs } from './constants.js'

export type MessageContent = RoomMessageTextEventContent | MediaEventContent

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
  signal?: AbortSignal
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
      return fetch(input, {
        ...init,
        redirect: 'error',
        ...(signal
          ? {
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal
            }
          : {})
      })
    }
  })
}
