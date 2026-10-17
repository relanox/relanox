import { decodeDurableRecord } from './record-codec.js'
import type { Storage, InboundRecord, OutboundRecord } from '@relanox/sdk'
import { isFiltered, needsPreparation } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit } from './database.js'
import { randomUUID } from 'node:crypto'
import {
  isActiveLease,
  expireInbound,
  settleInbound
} from '@relanox/storage-support'
import { and, eq, isNull, lt, lte, ne, notExists, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import {
  inbound,
  outbound,
  isBlockingDelivery,
  isDueRequest,
  isPendingDelivery
} from './schema.js'
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
            isFiltered(record) ||
            record.reply?.finalDeliveryId !== undefined ||
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
      const limit = boundedLimit(input.limit)
      return transaction(() => {
        const work: Awaited<ReturnType<Storage['takeDue']>>[number][] = []

        // Bound recovery independently so expired calls cannot force full-backlog decoding.
        const expiredRequests = db
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              isDueRequest(inbound.status),
              lte(inbound.leaseExpiresAt, input.now)
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(limit)
          .all()

        for (const row of expiredRequests) {
          saveInbound(expireInbound(decodeDurableRecord(row.record)))
        }

        const expiredDeliveries = db
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              isPendingDelivery(outbound.status),
              lte(outbound.leaseExpiresAt, input.now)
            )
          )
          .orderBy(rowId(outbound))
          .limit(limit)
          .all()

        for (const row of expiredDeliveries) {
          const record = decodeDurableRecord<OutboundRecord>(row.record)

          const next = {
            ...record,
            version: record.version + 1,
            status: input.safeRetryAccountIds.includes(record.target.accountId)
              ? ('pending' as const)
              : ('unknown' as const),
            errorCode: 'lease_expired'
          }

          delete next.lease
          saveOutbound(next)
        }

        const requests = db
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              isDueRequest(inbound.status),
              isNull(inbound.leaseExpiresAt),
              lte(inbound.dueAt, input.now)
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(limit)
          .all()

        const earlier = alias(outbound, 'earlier')

        const deliveries = db
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              isPendingDelivery(outbound.status),
              notExists(
                db
                  .select({ id: earlier.id })
                  .from(earlier)
                  .where(
                    and(
                      eq(earlier.channelId, outbound.channelId),
                      lt(rowId(earlier), rowId(outbound)),
                      isBlockingDelivery(earlier.status),
                      or(
                        eq(earlier.status, 'pending'),
                        ne(jsonValue(earlier.record, '$.target.channel'), 'qq')
                      )
                    )
                  )
              ),
              isNull(outbound.leaseExpiresAt),
              lte(outbound.dueAt, input.now)
            )
          )
          .orderBy(rowId(outbound))
          .limit(limit)
          .all()

        let requestIndex = 0
        let deliveryIndex = 0
        let preferredKind = input.preferredKind ?? 'inbound'

        while (work.length < limit) {
          const selectInbound =
            (preferredKind === 'inbound' ||
              deliveryIndex >= deliveries.length) &&
            requestIndex < requests.length

          if (selectInbound) {
            const row = requests[requestIndex++]
            if (!row) {
              break
            }
            const record = decodeDurableRecord<InboundRecord>(row.record)

            const lease = {
              token: `${input.leaseOwner}:${randomUUID()}`,
              version: record.version + 1,
              expiresAt: input.now + input.leaseMs
            }

            const next = {
              ...record,
              version: lease.version,
              dispatch: { ...record.dispatch, lease }
            }

            saveInbound(next)
            work.push({
              kind: needsPreparation(next) ? 'prepare' : 'dispatch',
              record: next,
              lease
            })
            preferredKind = 'send'
          } else if (deliveryIndex < deliveries.length) {
            const row = deliveries[deliveryIndex++]
            if (!row) {
              break
            }
            const record = decodeDurableRecord<OutboundRecord>(row.record)

            const lease = {
              token: `${input.leaseOwner}:${randomUUID()}`,
              version: record.version + 1,
              expiresAt: input.now + (input.sendLeaseMs ?? input.leaseMs)
            }

            const next = { ...record, version: lease.version, lease }
            saveOutbound(next)
            work.push({ kind: 'send', record: next, lease })
            preferredKind = 'inbound'
          } else {
            break
          }
        }
        return work
      })
    },
    async settleAttempt(input) {
      return transaction(() => {
        if (input.kind !== 'send') {
          const record = readInbound(input.id)
          if (!record) {
            return { status: 'not_found' }
          }
          const next = settleInbound(record, input)
          if (!next) {
            return { status: 'conflict' }
          }
          saveInbound(next)
          return { status: 'updated', version: next.version }
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
