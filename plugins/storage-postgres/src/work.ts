import type { Storage, DueWork } from '@relanox/sdk'
import type { DatabaseContext } from './database.js'
import { boundedLimit } from './database.js'
import { randomUUID } from 'node:crypto'
import { isActiveLease } from '@relanox/storage-support'
import {
  and,
  eq,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  inArray,
  or,
  sql
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { inbound, outbound } from './schema.js'

export function createWorkOperations(
  context: Pick<
    DatabaseContext,
    | 'transaction'
    | 'readInbound'
    | 'readOutbound'
    | 'saveInbound'
    | 'saveOutbound'
  >
): Pick<Storage, 'requeue' | 'takeDue' | 'settleAttempt'> {
  const { transaction, readInbound, readOutbound, saveInbound, saveOutbound } =
    context

  return {
    async requeue(input) {
      return transaction(async (client) => {
        if (input.kind === 'request') {
          const record = await readInbound(client, input.id)
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

          await saveInbound(client, next)
          return { status: 'updated', version: next.version }
        }
        const record = await readOutbound(client, input.id)
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
        await saveOutbound(client, next)
        return { status: 'updated', version: next.version }
      })
    },
    async takeDue(input) {
      const limit = boundedLimit(input.limit)
      return transaction(async (client) => {
        const work: DueWork[] = []

        // Expiry recovery and executable selection are separate bounded scans. Unknown effects never auto-repeat.
        const expiredRequests = await client
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              eq(inbound.status, 'due'),
              lte(
                sql<number>`(${inbound.record}#>>'{dispatch,lease,expiresAt}')::bigint`,
                input.now
              )
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(limit)

        for (const { record } of expiredRequests) {
          const dispatch = {
            ...record.dispatch,
            status: 'unknown' as const,
            errorCode: 'lease_expired'
          }

          delete dispatch.lease
          await saveInbound(client, {
            ...record,
            version: record.version + 1,
            dispatch
          })
        }

        const expiredDeliveries = await client
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              eq(outbound.status, 'pending'),
              lte(
                sql<number>`(${outbound.record}#>>'{lease,expiresAt}')::bigint`,
                input.now
              )
            )
          )
          .orderBy(outbound.id)
          .limit(limit)

        for (const { record } of expiredDeliveries) {
          const next = {
            ...record,
            version: record.version + 1,
            status: input.safeRetryAccountIds.includes(record.target.accountId)
              ? ('pending' as const)
              : ('unknown' as const),
            errorCode: 'lease_expired'
          }

          delete next.lease
          await saveOutbound(client, next)
        }

        const requests = await client
          .select({ record: inbound.record })
          .from(inbound)
          .where(
            and(
              eq(inbound.status, 'due'),
              isNull(sql`${inbound.record}#>'{dispatch,lease}'`),
              lte(
                sql<number>`(${inbound.record}#>>'{dispatch,dueAt}')::bigint`,
                input.now
              )
            )
          )
          .orderBy(inbound.acceptedAt, inbound.id)
          .limit(limit)

        for (const { record } of requests) {
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

          await saveInbound(client, next)
          work.push({ kind: 'dispatch', record: next, lease })
        }

        const earlier = alias(outbound, 'earlier')

        const deliveries = await client
          .select({ record: outbound.record })
          .from(outbound)
          .where(
            and(
              eq(outbound.status, 'pending'),
              notExists(
                client
                  .select({ id: earlier.id })
                  .from(earlier)
                  .where(
                    and(
                      eq(earlier.channelId, outbound.channelId),
                      lt(earlier.sequence, outbound.sequence),
                      inArray(earlier.status, ['pending', 'unknown']),
                      or(
                        eq(earlier.status, 'pending'),
                        ne(
                          sql<string>`${earlier.record}#>>'{target,channel}'`,
                          'qq'
                        )
                      )
                    )
                  )
              ),
              isNull(sql`${outbound.record}->'lease'`),
              lte(
                sql<number>`(${outbound.record}->>'dueAt')::bigint`,
                input.now
              )
            )
          )
          .orderBy(outbound.sequence)
          .limit(limit - work.length)

        for (const { record } of deliveries) {
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: record.version + 1,
            expiresAt: input.now + input.leaseMs
          }

          const next = { ...record, version: lease.version, lease }
          await saveOutbound(client, next)
          work.push({ kind: 'send', record: next, lease })
        }
        return work
      })
    },
    async settleAttempt(input) {
      return transaction(async (client) => {
        if (input.kind === 'dispatch') {
          const record = await readInbound(client, input.id)
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

          await saveInbound(client, {
            ...record,
            version: record.version + 1,
            dispatch
          })
          return { status: 'updated', version: record.version + 1 }
        }
        const record = await readOutbound(client, input.id)
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

        const next = {
          ...record,
          version: record.version + 1,
          attempts: record.attempts + 1,
          dueAt: input.nextDueAt
        }

        delete next.lease
        delete next.errorCode
        if (input.outcome.status === 'sent') {
          next.currentChunk++
          next.attempts = 0
          next.receipts = [...record.receipts, input.outcome.receipt]
          next.status =
            next.currentChunk === next.chunks.length ? 'sent' : 'pending'
        } else if (input.outcome.status === 'pending') {
          next.attempts = record.attempts
          next.status = 'pending'
        } else {
          next.status =
            input.outcome.status === 'retryable'
              ? 'pending'
              : input.outcome.status
          next.errorCode = input.outcome.errorCode
        }
        await saveOutbound(client, next)
        return { status: 'updated', version: next.version }
      })
    }
  }
}
