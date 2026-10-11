import type { Writable } from 'node:stream'
import type {
  Observability,
  ObservabilityPlugin,
  ObservabilityRuntime
} from '@relanox/sdk'
import { validateStandardConfig } from './config.js'
import type { StandardConfig } from './config.js'
import { createLogs } from './logs.js'
import { createMetrics } from './metrics.js'
import { createTracing } from './tracing.js'
import { runWithLifecycleDeadline } from './lifecycle.js'

export { validateStandardConfig } from './config.js'
export type { StandardConfig } from './config.js'
export { events, operations, metricDefinitions } from './fields.js'

/** Destination is for a production-owned collector stream; the plugin never owns/ends stdout or that stream. */
export function createStandardObservability(
  options: { readonly logDestination?: Writable } = {}
): ObservabilityPlugin<StandardConfig> {
  return {
    id: 'observability-standard',
    kind: 'observability',
    sdkMajor: 1,
    runtime: 'node',
    validateConfig: validateStandardConfig,
    async setup(input): Promise<ObservabilityRuntime> {
      const config = validateStandardConfig(input)
      let closed = false
      const telemetry = createMetrics(config)
      const { registry, dropped, metrics } = telemetry

      const isolate = (operation: () => void, signal: string): void => {
        if (closed) {
          return
        }
        try {
          operation()
        } catch {
          dropped.inc({ signal })
        }
      }

      const { writer, log } = createLogs(
        config,
        options.logDestination ?? process.stdout,
        () => {
          dropped.inc({ signal: 'logs' })
        }
      )

      const { provider, span } = createTracing(
        config,
        () => closed,
        isolate,
        () => {
          dropped.inc({ signal: 'traces' })
        }
      )

      const observe: Observability = {
        log(level, event, fields) {
          isolate(() => {
            log(level, event, fields)
          }, 'logs')
        },
        count(name, labels, value) {
          isolate(() => {
            telemetry.count(name, labels, value)
          }, 'metrics')
        },
        record(name, value, labels) {
          isolate(() => {
            telemetry.record(name, value, labels)
          }, 'metrics')
        },
        span
      }

      let shutdown: Promise<void> | undefined
      return {
        observe,
        ...(config.metrics ? { metrics } : {}),
        async flush(signal) {
          if (closed) {
            return
          }
          await runWithLifecycleDeadline(
            signal,
            config.lifecycleTimeoutMs,
            () => {
              dropped.inc({ signal: 'traces' })
            },
            async (deadline) => {
              await Promise.all([
                writer.flush(deadline),
                provider?.forceFlush()
              ])
            }
          )
        },
        shutdown(signal) {
          shutdown ??= (async () => {
            closed = true

            // Start shutdown even for an already-aborted caller, so provider timers are always released.
            const stopped = provider?.shutdown().catch(() => {
              dropped.inc({ signal: 'traces' })
            })

            await runWithLifecycleDeadline(
              signal,
              config.lifecycleTimeoutMs,
              () => {
                dropped.inc({ signal: 'traces' })
              },
              async (deadline) => {
                await Promise.all([writer.flush(deadline), stopped])
              }
            )
            writer.close()
            registry.clear()
          })()
          return shutdown
        }
      }
    }
  }
}
