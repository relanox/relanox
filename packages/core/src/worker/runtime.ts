import type {
  DispatchResult,
  SendResult,
  DueWork,
  RelanoxConfig,
  Observability,
  TraceContext,
  Settlement
} from '@relanox/sdk'
import type { CoreOptions } from '../types.js'
import type { WorkerConfig } from './options.js'
import { jsonSnapshot } from '../json.js'
import { validateDispatchOutcome, validateSendOutcome } from './outcomes.js'
import { sendChunk } from './media.js'
import { retryDelay, retryBudgetExhausted } from './retry.js'
import { preparedRequest, transcribeRequest } from '../speech.js'

/** Owns one-at-a-time leases, plugin deadlines, retry settlement, and worker readiness. */
export function createWorker(
  options: Pick<
    CoreOptions,
    'storage' | 'channels' | 'agents' | 'speechToText'
  >,
  config: RelanoxConfig,
  worker: WorkerConfig,
  observe: Observability,
  isAccepting: () => boolean
): {
  hasError(this: void): boolean
  processDue(this: void): Promise<{ processed: number; conflicts: number }>
} {
  const storage = options.storage
  let busy = false
  let workerError = false
  const owner = crypto.randomUUID()

  async function refreshStats(): Promise<void> {
    try {
      const stats = await storage.getStats()
      observe.record('relanox_pending', stats.pending)
      observe.record('relanox_outbound', stats.undelivered)
      observe.record('relanox_unknown', stats.unknown)
      observe.record(
        'relanox_oldest_pending_age_seconds',
        stats.oldestPendingAt === undefined
          ? 0
          : Math.max(0, (Date.now() - stats.oldestPendingAt) / 1000)
      )
      observe.record('relanox_storage_stats_stale', 0)
    } catch {
      observe.record('relanox_storage_stats_stale', 1)
    }
  }

  const safeRetryAccountIds = config.accounts
    .filter((a) => options.channels.get(a.id)?.capabilities.idempotentSend)
    .map((a) => a.id)

  async function invoke<T extends DispatchResult | SendResult>(
    operationName: 'dispatch' | 'send',
    operation: (signal: AbortSignal) => Promise<T> | undefined,
    validate: (input: unknown) => T,
    trace?: TraceContext
  ): Promise<T | { status: 'unknown' | 'rejected'; errorCode: string }> {
    const controller = new AbortController()

    const span = observe.span(
      operationName,
      { plugin: 'core', operation: operationName },
      trace
    )

    const startedAt = Date.now()
    let successful = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<{ status: 'unknown'; errorCode: string }>(
        (resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve({ status: 'unknown', errorCode: 'call_timeout' })
          }, worker.callTimeoutMs)
        }
      )

      const pending = operation(controller.signal)
      if (!pending) {
        return { status: 'rejected', errorCode: 'plugin_missing' }
      }
      const result = await Promise.race([pending, timeout])
      const valid = validate(result)
      successful =
        valid.status === 'sent' ||
        valid.status === 'accepted' ||
        valid.status === 'pending'
      return valid
    } catch {
      return { status: 'unknown', errorCode: 'plugin_exception' }
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      span.end(successful ? 'ok' : 'error')
      observe.record(
        operationName === 'dispatch'
          ? 'relanox_dispatch_duration_seconds'
          : 'relanox_send_duration_seconds',
        (Date.now() - startedAt) / 1000,
        { operation: operationName }
      )
    }
  }

  function applyRetryBudget<T extends DispatchResult | SendResult>(
    outcome: T,
    attempts: number
  ): T | { status: 'rejected'; errorCode: string } {
    return retryBudgetExhausted(outcome, attempts, worker.maxAttempts)
      ? { status: 'rejected' as const, errorCode: 'retry_budget_exhausted' }
      : outcome
  }

  async function settlementFor(work: DueWork): Promise<Settlement> {
    if (work.kind === 'transcribe') {
      const transcriptions = await transcribeRequest(
        work.record,
        storage,
        options.speechToText,
        worker.callTimeoutMs,
        observe
      )

      return {
        kind: 'transcribe',
        id: work.record.snapshot.requestId,
        lease: work.lease,
        outcome: { status: 'prepared', transcriptions },
        now: Date.now()
      }
    }
    if (work.kind === 'dispatch') {
      const request = preparedRequest(work.record)
      const attempts = work.record.dispatch.attempts

      const outcome = applyRetryBudget(
        attempts >= worker.maxAttempts
          ? { status: 'rejected' as const, errorCode: 'retry_budget_exhausted' }
          : await invoke(
              'dispatch',
              (signal): Promise<DispatchResult> | undefined =>
                options.agents.get(request.endpoint.agent)?.dispatch({
                  request: jsonSnapshot(request),
                  signal
                }),
              validateDispatchOutcome,
              request.trace
            ),
        attempts
      )

      const now = Date.now()
      return {
        kind: 'dispatch',
        id: request.requestId,
        lease: work.lease,
        outcome,
        nextDueAt: now + retryDelay(outcome, attempts, worker),
        now
      }
    }
    const record = work.record

    const outcome = applyRetryBudget(
      record.attempts >= worker.maxAttempts
        ? { status: 'rejected' as const, errorCode: 'retry_budget_exhausted' }
        : await invoke(
            'send',
            async (signal) =>
              sendChunk(
                storage,
                options.channels.get(record.target.accountId),
                record,
                worker.maxMediaBytes,
                signal
              ),
            validateSendOutcome,
            record.trace
          ),
      record.attempts
    )

    const now = Date.now()
    return {
      kind: 'send',
      id: record.deliveryId,
      lease: work.lease,
      outcome,
      nextDueAt: now + retryDelay(outcome, record.attempts, worker),
      now
    }
  }

  function canStartWork(start: number, processed: number): boolean {
    return (
      isAccepting() &&
      processed < worker.batchSize &&
      Date.now() - start < worker.batchDurationMs
    )
  }

  return {
    hasError: () => workerError,
    async processDue(): Promise<{ processed: number; conflicts: number }> {
      if (busy) {
        return { processed: 0, conflicts: 0 }
      }
      busy = true
      const start = Date.now()
      let processed = 0
      let conflicts = 0
      try {
        while (canStartWork(start, processed)) {
          // Lease one at a time, so queued calls cannot expire behind earlier slow calls.
          const work = (
            await storage.takeDue({
              now: Date.now(),
              leaseMs: worker.leaseMs,
              limit: 1,
              leaseOwner: owner,
              safeRetryAccountIds
            })
          )[0]

          if (!work) {
            break
          }
          const attempt = await settlementFor(work)
          const { outcome } = attempt
          const settlement = await storage.settleAttempt(attempt)
          if (settlement.status !== 'updated') {
            conflicts++
          }
          processed++
          if (work.kind === 'dispatch') {
            observe.count('relanox_dispatch_total', {
              agent: work.record.snapshot.endpoint.agent,
              outcome: outcome.status
            })
          } else if (work.kind === 'send') {
            observe.count('relanox_delivery_total', {
              channel: work.record.target.channel,
              outcome: outcome.status
            })
          }
          if (outcome.status === 'retryable') {
            observe.count('relanox_retries_total', { operation: work.kind })
          }
          observe.log(
            outcome.status === 'unknown' || outcome.status === 'rejected'
              ? 'warn'
              : 'info',
            work.kind === 'send'
              ? 'delivery.completed'
              : `${work.kind}.completed`,
            {
              plugin: 'core',
              operation: work.kind,
              ...(work.kind !== 'send'
                ? { requestId: work.record.snapshot.requestId }
                : { channelId: work.record.channelId }),
              outcome: outcome.status,
              ...('errorCode' in outcome
                ? { errorCode: outcome.errorCode }
                : {})
            }
          )
        }
        workerError = false
        observe.record(
          'relanox_worker_last_success_timestamp_seconds',
          Date.now() / 1000
        )
        await refreshStats()
        return { processed, conflicts }
      } catch (error) {
        workerError = true
        throw error
      } finally {
        busy = false
      }
    }
  }
}
