import type { Server } from 'node:http'
import type { Lifecycle, ObservabilityRuntime, Storage } from '@relanox/sdk'
import { deadline } from './deadline.js'
import { closeServer } from './listeners.js'

export function createLifecycle(
  timeoutMs: number,
  plugins: readonly Lifecycle[]
): {
  signal: AbortSignal
  servers: Server[]
  live(this: void): boolean
  registerStorage(this: void, resource: Storage): void
  registerObservability(this: void, resource: ObservabilityRuntime): void
  registerCore(
    this: void,
    setAccepting: () => void,
    worker: () => Promise<void>
  ): void
  stop(this: void): Promise<void>
} {
  const abort = new AbortController()
  const servers: Server[] = []
  let storage: Storage | undefined
  let observability: ObservabilityRuntime | undefined
  let stopWorker = async (): Promise<void> => {}
  let stopAccepting = (): void => {}
  let stopping = false
  let stopPromise: Promise<void> | undefined
  let deadlineAt = 0
  const remaining = (): number => Math.max(0, deadlineAt - Date.now())

  const attempt = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await deadline(action(), remaining())
      return true
    } catch {
      return false
    }
  }

  return {
    signal: abort.signal,
    servers,
    live: () => !stopping,
    registerStorage(resource: Storage): void {
      storage = resource
    },
    registerObservability(resource: ObservabilityRuntime): void {
      observability = resource
    },
    registerCore(setAccepting: () => void, worker: () => Promise<void>): void {
      stopAccepting = setAccepting
      stopWorker = worker
    },
    async stop(): Promise<void> {
      stopPromise ??= (async (): Promise<undefined> => {
        deadlineAt = Date.now() + timeoutMs
        stopping = true
        stopAccepting()
        abort.abort()

        const draining = await Promise.all([
          attempt(stopWorker),
          ...servers.map(async (server) =>
            attempt(async () => closeServer(server))
          ),
          ...plugins.map(async (plugin) => attempt(async () => plugin.stop?.()))
        ])

        for (const server of servers) {
          server.closeAllConnections()
        }
        const closedStorage = await attempt(async () => storage?.close())

        const closedObserve = await attempt(async () =>
          observability?.shutdown(AbortSignal.timeout(remaining()))
        )

        if (!closedStorage || !closedObserve || draining.includes(false)) {
          throw new Error('shutdown_incomplete')
        }
      })()
      return stopPromise
    }
  }
}
