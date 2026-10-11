import { decodeDurableRecord } from './record-codec.js'
import type { Storage, InboundRecord, OutboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { randomUUID } from 'node:crypto'
import { isActiveLease } from '@relanox/storage-support'

export function createWorkOperations(
  context: Pick<
    DatabaseContext,
    | 'db'
    | 'transaction'
    | 'readInbound'
    | 'readOutbound'
    | 'saveInbound'
    | 'saveOutbound'
  >
): Pick<Storage, 'requeue' | 'takeDue' | 'settleAttempt'> {
  const {
    db,
    transaction,
    readInbound,
    readOutbound,
    saveInbound,
    saveOutbound
  } = context

  return {
    async requeue(input) {
      return transaction(() => {
        if (input.kind === 'request') {
          const record = readInbound(input.id)
          if (!record) {
            return { status: 'not_found' }
          }
          if (
            record.version !== input.expectedVersion ||
            record.redactedAt !== undefined ||
            !['accepted', 'unknown', 'rejected'].includes(
              record.dispatch.status
            ) ||
            (record.dispatch.status === 'unknown' && !input.acknowledgeUnknown)
          ) {
            return { status: 'conflict' }
          }

          const next = {
            ...record,
            version: record.version + 1,
            dispatch: { status: 'due' as const, attempts: 0, dueAt: input.now }
          }

          saveInbound(next)
          return { status: 'updated', version: next.version }
        }
        const record = readOutbound(input.id)
        if (!record) {
          return { status: 'not_found' }
        }
        if (
          record.version !== input.expectedVersion ||
          !['rejected', 'unknown'].includes(record.status) ||
          (record.status === 'unknown' && !input.acknowledgeUnknown)
        ) {
          return { status: 'conflict' }
        }

        const next = {
          ...record,
          status: 'pending' as const,
          version: record.version + 1,
          attempts: 0,
          dueAt: input.now
        }

        delete next.lease
        delete next.errorCode
        saveOutbound(next)
        return { status: 'updated', version: next.version }
      })
    },
    async takeDue(input) {
      return transaction(() => {
        const work: Awaited<ReturnType<Storage['takeDue']>>[number][] = []
        for (const record of (
          db
            .prepare(
              `
                SELECT record
                FROM inbound
                WHERE status='due'
                  AND (json_extract(record,'$.dispatch.lease.expiresAt')<=?
                    OR (json_extract(record,'$.dispatch.lease') IS NULL
                      AND json_extract(record,'$.dispatch.dueAt')<=?
                      AND json_extract(record,'$.dispatch.status') ='due'))
                ORDER BY accepted_at,id
              `
            )
            .all(input.now, input.now) as { record: string }[]
        ).map((row) => decodeDurableRecord<InboundRecord>(row.record))) {
          let next = record
          if (
            record.dispatch.lease &&
            record.dispatch.lease.expiresAt <= input.now
          ) {
            const dispatch = {
              ...record.dispatch,
              status: 'unknown' as const,
              errorCode: 'lease_expired'
            }

            delete dispatch.lease
            next = { ...record, version: record.version + 1, dispatch }
            saveInbound(next)
          }
          if (
            work.length >= input.limit ||
            next.dispatch.status !== 'due' ||
            next.dispatch.lease ||
            next.dispatch.dueAt > input.now
          ) {
            continue
          }

          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: next.version + 1,
            expiresAt: input.now + input.leaseMs
          }

          next = {
            ...next,
            version: lease.version,
            dispatch: { ...next.dispatch, lease }
          }
          saveInbound(next)
          work.push({ kind: 'dispatch', record: next, lease })
        }
        for (const record of (
          db
            .prepare(
              `
                SELECT record
                FROM outbound o
                WHERE o.status='pending'
                  AND NOT EXISTS(SELECT 1 FROM outbound earlier WHERE earlier.request_id=o.request_id AND earlier.rowid<o.rowid AND earlier.status IN ('pending','unknown'))
                  AND (json_extract(record,'$.lease.expiresAt')<=?
                    OR (json_extract(record,'$.lease') IS NULL
                      AND json_extract(record,'$.dueAt')<=?))
                ORDER BY o.rowid
              `
            )
            .all(input.now, input.now) as { record: string }[]
        ).map((row) => decodeDurableRecord<OutboundRecord>(row.record))) {
          let next = record
          if (record.lease && record.lease.expiresAt <= input.now) {
            next = {
              ...record,
              version: record.version + 1,
              status: input.safeRetryAccountIds.includes(
                record.target.accountId
              )
                ? 'pending'
                : 'unknown',
              errorCode: 'lease_expired'
            }
            const { lease: _expiredLease, ...recovered } = next
            next = recovered
            saveOutbound(next)
          }
          if (
            work.length >= input.limit ||
            next.status !== 'pending' ||
            next.lease ||
            next.dueAt > input.now
          ) {
            continue
          }

          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: next.version + 1,
            expiresAt: input.now + input.leaseMs
          }

          next = { ...next, version: lease.version, lease }
          saveOutbound(next)
          work.push({ kind: 'send', record: next, lease })
        }
        return work
      })
    },
    async settleAttempt(input) {
      return transaction(() => {
        if (input.kind === 'dispatch') {
          const record = readInbound(input.id)
          if (!record) {
            return { status: 'not_found' }
          }
          if (
            record.version !== input.lease.version ||
            !isActiveLease(record.dispatch.lease, input.lease, input.now)
          ) {
            return { status: 'conflict' }
          }
          const outcome = input.outcome

          const dispatch = {
            status:
              outcome.status === 'retryable'
                ? ('due' as const)
                : outcome.status,
            attempts: record.dispatch.attempts + 1,
            dueAt: input.nextDueAt,
            ...('errorCode' in outcome ? { errorCode: outcome.errorCode } : {})
          }

          saveInbound({ ...record, version: record.version + 1, dispatch })
          return { status: 'updated', version: record.version + 1 }
        }
        const record = readOutbound(input.id)
        if (!record) {
          return { status: 'not_found' }
        }
        if (
          record.status !== 'pending' ||
          record.version !== input.lease.version ||
          !isActiveLease(record.lease, input.lease, input.now)
        ) {
          return { status: 'conflict' }
        }
        const outcome = input.outcome

        const next = {
          ...record,
          version: record.version + 1,
          attempts: record.attempts + 1,
          dueAt: input.nextDueAt
        }

        delete next.lease
        delete next.errorCode
        if (outcome.status === 'sent') {
          next.currentChunk++
          next.attempts = 0
          next.receipts = [...record.receipts, outcome.receipt]
          next.status =
            next.currentChunk === next.chunks.length ? 'sent' : 'pending'
        } else {
          next.status =
            outcome.status === 'retryable' ? 'pending' : outcome.status
          next.errorCode = outcome.errorCode
        }
        saveOutbound(next)
        return { status: 'updated', version: next.version }
      })
    }
  }
}
