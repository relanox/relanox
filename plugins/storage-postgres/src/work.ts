import type { Storage, DueWork, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { boundedLimit } from "./database.js";
import { randomUUID } from "node:crypto";
import { isActiveLease } from "./record-contracts.js";

export function createWorkOperations(
  context: DatabaseContext,
): Pick<Storage, "requeue" | "takeDue" | "settleAttempt"> {
  const { query, transaction, inbound, outbound, saveInbound, saveOutbound } = context;
  return {
    async requeue(input) {
      return transaction(async (client) => {
        if (input.kind === "request") {
          const r = await inbound(client, input.id);
          if (!r) {
            return { status: "not_found" };
          }
          if (
            r.version !== input.expectedVersion ||
            r.redactedAt !== undefined ||
            r.status === "completed" ||
            !(
              r.status === "claimed" ||
              r.status === "failed" ||
              r.dispatch.status === "unknown" ||
              r.dispatch.status === "rejected"
            ) ||
            (r.dispatch.status === "unknown" && !input.acknowledgeUnknown)
          ) {
            return { status: "conflict" };
          }
          const next = {
            ...r,
            status: "pending" as const,
            version: r.version + 1,
            dispatch: { status: "due" as const, attempts: 0, dueAt: input.now },
          };
          delete next.claim;
          delete next.errorCode;
          await saveInbound(client, next);
          return { status: "updated", version: next.version };
        }
        const r = await outbound(client, input.id);
        if (!r) {
          return { status: "not_found" };
        }
        if (
          r.version !== input.expectedVersion ||
          !["rejected", "unknown"].includes(r.status) ||
          (r.status === "unknown" && !input.acknowledgeUnknown)
        ) {
          return { status: "conflict" };
        }
        const next = {
          ...r,
          status: "pending" as const,
          version: r.version + 1,
          attempts: 0,
          dueAt: input.now,
        };
        delete next.lease;
        delete next.errorCode;
        await saveOutbound(client, next);
        return { status: "updated", version: next.version };
      });
    },
    async takeDue(input) {
      const limit = boundedLimit(input.limit);
      return transaction(async (client) => {
        const work: DueWork[] = [];
        // Expiry recovery and executable selection are separate bounded scans. Unknown effects never auto-repeat.
        const expiredIn = await query<{ record: InboundRecord }>(
          client,
          "SELECT record FROM inbound WHERE status='pending' AND record#>>'{snapshot,endpoint,dispatchMode}'='push' AND (record#>>'{dispatch,lease,expiresAt}')::bigint<=$1 ORDER BY accepted_at,id LIMIT $2",
          [input.now, limit],
        );
        for (const { record: r } of expiredIn) {
          const dispatch = {
            ...r.dispatch,
            status: "unknown" as const,
            errorCode: "lease_expired",
          };
          delete dispatch.lease;
          await saveInbound(client, { ...r, version: r.version + 1, dispatch });
        }
        const expiredOut = await query<{ record: OutboundRecord }>(
          client,
          "SELECT record FROM outbound WHERE status='pending' AND (record#>>'{lease,expiresAt}')::bigint<=$1 ORDER BY id LIMIT $2",
          [input.now, limit],
        );
        for (const { record: r } of expiredOut) {
          const next = {
            ...r,
            version: r.version + 1,
            status: input.safeRetryAccountIds.includes(r.target.accountId)
              ? ("pending" as const)
              : ("unknown" as const),
            errorCode: "lease_expired",
          };
          delete next.lease;
          await saveOutbound(client, next);
        }
        const requests = await query<{ record: InboundRecord }>(
          client,
          `
          SELECT i.record FROM inbound i WHERE i.status='pending'
            AND i.record#>>'{snapshot,endpoint,dispatchMode}'='push'
            AND i.record#>>'{dispatch,status}' IN ('due','accepted')
            AND i.record#>'{dispatch,lease}' IS NULL AND (i.record#>>'{dispatch,dueAt}')::bigint<=$1
            AND NOT EXISTS(SELECT 1 FROM inbound earlier WHERE earlier.endpoint=i.endpoint AND earlier.id<>i.id
              AND earlier.status IN ('pending','claimed') AND (earlier.status='claimed'
                OR earlier.record#>'{dispatch,lease}' IS NOT NULL OR (earlier.record#>>'{dispatch,attempts}')::int>0
                OR earlier.record#>>'{dispatch,status}' IN ('unknown','rejected')
                OR ((i.record#>>'{dispatch,attempts}')::int=0 AND (earlier.accepted_at,earlier.id)<(i.accepted_at,i.id))))
          ORDER BY i.accepted_at,i.id LIMIT $2`,
          [input.now, limit],
        );
        for (const { record: r } of requests) {
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: r.version + 1,
            expiresAt: input.now + input.leaseMs,
          };
          const next = {
            ...r,
            version: lease.version,
            dispatch: { ...r.dispatch, lease },
          };
          await saveInbound(client, next);
          work.push({ kind: "dispatch", record: next, lease });
        }
        const deliveries = await query<{ record: OutboundRecord }>(
          client,
          "SELECT record FROM outbound WHERE status='pending' AND record->'lease' IS NULL AND (record->>'dueAt')::bigint<=$1 ORDER BY id LIMIT $2",
          [input.now, limit - work.length],
        );
        for (const { record: r } of deliveries) {
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: r.version + 1,
            expiresAt: input.now + input.leaseMs,
          };
          const next = { ...r, version: lease.version, lease };
          await saveOutbound(client, next);
          work.push({ kind: "send", record: next, lease });
        }
        return work;
      });
    },
    async settleAttempt(input) {
      return transaction(async (client) => {
        if (input.kind === "dispatch") {
          const r = await inbound(client, input.id);
          if (!r) {
            return { status: "not_found" };
          }
          if (
            r.status !== "pending" ||
            r.version !== input.lease.version ||
            !isActiveLease(r.dispatch.lease, input.lease, input.now)
          ) {
            return { status: "conflict" };
          }
          const outcome = input.outcome;
          const dispatch = {
            status: outcome.status === "retryable" ? ("due" as const) : outcome.status,
            attempts: r.dispatch.attempts + 1,
            dueAt: input.nextDueAt,
            ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}),
          };
          await saveInbound(client, { ...r, version: r.version + 1, dispatch });
          return { status: "updated", version: r.version + 1 };
        }
        const r = await outbound(client, input.id);
        if (!r) {
          return { status: "not_found" };
        }
        if (
          r.status !== "pending" ||
          r.version !== input.lease.version ||
          !isActiveLease(r.lease, input.lease, input.now)
        ) {
          return { status: "conflict" };
        }
        const next = {
          ...r,
          version: r.version + 1,
          attempts: r.attempts + 1,
          dueAt: input.nextDueAt,
        };
        delete next.lease;
        delete next.errorCode;
        if (input.outcome.status === "sent") {
          next.currentChunk++;
          next.attempts = 0;
          next.receipts = [...r.receipts, input.outcome.receipt];
          next.status = next.currentChunk === next.chunks.length ? "sent" : "pending";
        } else {
          next.status = input.outcome.status === "retryable" ? "pending" : input.outcome.status;
          next.errorCode = input.outcome.errorCode;
        }
        await saveOutbound(client, next);
        return { status: "updated", version: next.version };
      });
    },
  };
}
