import type {
  InboundRecord,
  MessageMiddleware,
  MiddlewarePlan,
  MiddlewareResult,
  Observability,
  StoredMedia,
  Storage
} from '@relanox/sdk'
import { z } from 'zod'
import { middlewareMessage, preparedRequest } from '../middleware.js'
import { verifiedMedia } from '../media.js'
import { boundedText } from '../validation.js'
import { jsonSnapshot } from '../json.js'
import type { WorkerConfig } from './options.js'

const outputSchema = z.strictObject({
  text: z.string(),
  data: z.json().optional()
})

async function runMiddleware(
  record: InboundRecord,
  plan: MiddlewarePlan,
  middleware: MessageMiddleware,
  storage: Storage,
  signal: AbortSignal,
  worker: WorkerConfig,
  observe: Observability
): Promise<MiddlewareResult> {
  let output: unknown
  try {
    output = await middleware.process({
      message: middlewareMessage(preparedRequest(record)),
      options: jsonSnapshot(plan.options),
      signal,
      observe,
      async readMedia(id): Promise<StoredMedia | undefined> {
        const reference = record.snapshot.attachments?.find(
          (item) => item.id === id
        )

        if (!reference || signal.aborted) {
          return undefined
        }
        const stored = await storage.media?.get(record.snapshot.channel.id, id)
        return stored
          ? verifiedMedia(stored, reference, reference.size)
          : undefined
      }
    })
  } catch {
    return {
      id: plan.id,
      status: 'failed',
      errorCode: signal.aborted ? 'timeout' : 'middleware_failed'
    }
  }
  try {
    const valid = outputSchema.parse(output)
    boundedText(valid.text, worker.maxTextBytes, true)
    if (JSON.stringify(valid.data ?? null).length > worker.maxTextBytes) {
      throw new Error('middleware_data_too_large')
    }
    return {
      id: plan.id,
      status: 'completed',
      output: {
        text: valid.text,
        ...(valid.data === undefined ? {} : { data: valid.data })
      }
    }
  } catch {
    return { id: plan.id, status: 'failed', errorCode: 'invalid_result' }
  }
}

/** One bounded attempt for the entire ordered chain; notification retries reuse its saved outputs. */
export async function prepareRequest(
  record: InboundRecord,
  storage: Storage,
  middleware: readonly MessageMiddleware[],
  worker: WorkerConfig,
  observe: Observability
): Promise<readonly MiddlewareResult[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = Date.now()
  const results: MiddlewareResult[] = []
  try {
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve()
      }, worker.callTimeoutMs)
    })

    for (const plan of record.snapshot.middleware ?? []) {
      const plugin = middleware.find((item) => item.id === plan.id)

      const fallback: MiddlewareResult = {
        id: plan.id,
        status: 'failed',
        errorCode: plugin ? 'timeout' : 'disabled'
      }

      const result =
        !plugin || controller.signal.aborted
          ? fallback
          : await Promise.race([
              runMiddleware(
                { ...record, preparation: results },
                plan,
                plugin,
                storage,
                controller.signal,
                worker,
                observe
              ),
              deadline.then(() => fallback)
            ])

      results.push(result)
      observe.count('relanox_middleware_total', { outcome: result.status })
      if (result.status === 'failed') {
        observe.log('warn', 'middleware.failed', {
          plugin: 'core',
          requestId: record.snapshot.requestId,
          errorCode: result.errorCode
        })
      }
    }
    return results
  } finally {
    clearTimeout(timer)
    observe.record(
      'relanox_preparation_duration_seconds',
      (Date.now() - started) / 1000,
      { operation: 'prepare' }
    )
  }
}
