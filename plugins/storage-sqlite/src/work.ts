import { decodeDurableRecord } from './record-codec.js'
import type { Storage, InboundRecord, OutboundRecord } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { randomUUID } from 'node:crypto'
import { isActiveLease } from '@relanox/storage-support'
import { and, eq, isNull, lt, lte, notExists, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { inbound, outbound, isBlockingDelivery } from './schema.js'
import { jsonValue, rowId } from './expressions.js'

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
          record.redactedAt !== undefined ||
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
        for (const record of db
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              eq(inbound.status, 'due'),
              or(
                lte(
                  jsonValue<number>(
                    inbound.record,
                    '$.dispatch.lease.expiresAt'
                  ),
                  input.now
                ),
                and(
                  isNull(jsonValue(inbound.record, '$.dispatch.lease')),
                  lte(
                    jsonValue<number>(inbound.record, '$.dispatch.dueAt'),
                    input.now
                  ),
                  eq(jsonValue(inbound.record, '$.dispatch.status'), 'due')
                )
              )
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .all()
          .map((row) => decodeDurableRecord<InboundRecord>(row.record))) {
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
        const earlier = alias(outbound, 'earlier')
        for (const record of db
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              eq(outbound.status, 'pending'),
              notExists(
                db
                  .select({ id: earlier.id })
                  .from(earlier)
                  .where(
                    and(
                      eq(earlier.channelId, outbound.channelId),
                      lt(rowId(earlier), rowId(outbound)),
                      isBlockingDelivery(earlier.status)
                    )
                  )
              ),
              or(
                lte(
                  jsonValue<number>(outbound.record, '$.lease.expiresAt'),
                  input.now
                ),
                and(
                  isNull(jsonValue(outbound.record, '$.lease')),
                  lte(jsonValue<number>(outbound.record, '$.dueAt'), input.now)
                )
              )
            )
          )
          .orderBy(rowId(outbound))
          .all()
          .map((row) => decodeDurableRecord<OutboundRecord>(row.record))) {
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
            // Reply correlation can advance the record version while this dispatch is in flight.
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
        } else if (outcome.status === 'pending') {
          next.attempts = record.attempts
          next.status = 'pending'
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
