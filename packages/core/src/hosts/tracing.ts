import type { Observability, TraceContext, IngestInput } from '@relanox/sdk'

/** Trace storage-facing host operations without logging message content. */
export function createOperationTracer(observe: Observability) {
  async function traced<T>(
    operation: 'ingest' | 'claim' | 'complete' | 'fail' | 'storage',
    action: (context?: TraceContext) => Promise<T>,
    parent?: IngestInput['trace']
  ): Promise<T> {
    const span = observe.span(operation, { plugin: 'core', operation }, parent)
    const start = Date.now()
    try {
      const result = await action(span.context ?? parent)
      span.end('ok')
      return result
    } catch (error) {
      span.end('error')
      throw error
    } finally {
      observe.record(
        'relanox_storage_duration_seconds',
        (Date.now() - start) / 1000,
        {
          operation
        }
      )
    }
  }

  return traced
}
