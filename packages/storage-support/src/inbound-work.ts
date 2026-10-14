import { failedPreparation, needsPreparation } from '@relanox/sdk'
import type { InboundRecord, Settlement } from '@relanox/sdk'
import { isActiveLease } from './record-contracts.js'

/** An interrupted cloud call may have been charged. Fall back instead of repeating it. */
export function expireInbound(record: InboundRecord): InboundRecord {
  if (needsPreparation(record)) {
    return {
      ...record,
      version: record.version + 1,
      preparation: failedPreparation(record.snapshot, 'interrupted'),
      dispatch: {
        status: 'due',
        attempts: record.dispatch.attempts,
        dueAt: record.dispatch.dueAt
      }
    }
  }
  const { lease: _lease, ...dispatch } = record.dispatch
  return {
    ...record,
    version: record.version + 1,
    dispatch: { ...dispatch, status: 'unknown', errorCode: 'lease_expired' }
  }
}

/** Fence preparation and dispatch separately even though they share a queue lease. */
export function settleInbound(
  record: InboundRecord,
  input: Exclude<Settlement, { kind: 'send' }>
): InboundRecord | undefined {
  if (
    record.dispatch.status !== 'due' ||
    !isActiveLease(record.dispatch.lease, input.lease, input.now) ||
    needsPreparation(record) !== (input.kind === 'prepare')
  ) {
    return undefined
  }
  if (input.kind === 'prepare') {
    const stepIds = (record.snapshot.middleware ?? []).map((step) => step.id)

    const results = input.outcome.preparation
    if (
      stepIds.length !== results.length ||
      results.some((result, index) => result.id !== stepIds[index])
    ) {
      return undefined
    }
    return {
      ...record,
      preparation: results,
      version: record.version + 1,
      dispatch: {
        status: 'due',
        attempts: record.dispatch.attempts,
        dueAt: input.now
      }
    }
  }
  const outcome = input.outcome
  return {
    ...record,
    version: record.version + 1,
    dispatch: {
      status: outcome.status === 'retryable' ? 'due' : outcome.status,
      attempts: record.dispatch.attempts + 1,
      dueAt: input.nextDueAt,
      ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {})
    }
  }
}
