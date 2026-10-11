import type { CoreRuntime } from '@relanox/core'
import type { Observability } from '@relanox/sdk'

/** Schedule the next batch only after settlement, so slow batches never accumulate. */
export function createWorker(
  core: CoreRuntime,
  observe: Observability
): {
  start(this: void): void
  healthy(this: void): boolean
  stop(this: void): Promise<void>
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let working = Promise.resolve()
  let started = false
  let stopping = false
  let failed = false
  let lastSuccess = 0

  const tick = async (): Promise<void> => {
    try {
      await core.processDue()
      lastSuccess = Date.now()
      failed = false
      observe.record(
        'relanox_worker_last_success_timestamp_seconds',
        lastSuccess / 1000
      )
    } catch {
      failed = true
      observe.log('error', 'operation.failed', {
        plugin: 'cli',
        operation: 'worker',
        errorCode: 'storage'
      })
    } finally {
      if (!stopping) {
        timer = setTimeout(() => {
          working = tick()
        }, 1000)
      }
    }
  }

  return {
    start(): void {
      if (started || stopping) {
        return
      }
      started = true
      working = tick()
    },
    healthy(): boolean {
      return (
        !stopping &&
        !failed &&
        lastSuccess > 0 &&
        Date.now() - lastSuccess <= 60_000
      )
    },
    async stop(): Promise<void> {
      stopping = true
      clearTimeout(timer)
      return working
    }
  }
}
