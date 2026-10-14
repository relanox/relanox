import { failedTranscriptions, needsTranscription } from '@relanox/sdk'
import type { InboundRecord, Settlement } from '@relanox/sdk'
import { isActiveLease } from './record-contracts.js'

/** An interrupted cloud call may have been charged. Fall back instead of repeating it. */
export function expireInbound(record: InboundRecord): InboundRecord {
  if (needsTranscription(record)) {
    return {
      ...record,
      version: record.version + 1,
      transcriptions: failedTranscriptions(record.snapshot, 'interrupted'),
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
    needsTranscription(record) !== (input.kind === 'transcribe')
  ) {
    return undefined
  }
  if (input.kind === 'transcribe') {
    const audioIds = (record.snapshot.attachments ?? [])
      .filter((media) => media.kind === 'audio')
      .map((media) => media.id)

    const results = input.outcome.transcriptions
    if (
      audioIds.length !== results.length ||
      results.some((result, index) => result.mediaId !== audioIds[index])
    ) {
      return undefined
    }
    return {
      ...record,
      transcriptions: results,
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
