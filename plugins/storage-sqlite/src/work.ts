import type { Storage, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { randomUUID } from "node:crypto";
import { decode } from "./record-codec.js";
import { isActiveLease } from "./record-contracts.js";

export function createWorkOperations(
  context: DatabaseContext,
): Pick<Storage, "requeue" | "takeDue" | "settleAttempt"> {
  const { db, transaction, inbound, outbound, saveInbound, saveOutbound, isEndpointHead } = context;
  return {
    async requeue(input) {
      return transaction(() => {
        if (input.kind === "request") {
          const r = inbound(input.id);
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
          saveInbound(next);
          return { status: "updated", version: next.version };
        }
        const r = outbound(input.id);
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
        saveOutbound(next);
        return { status: "updated", version: next.version };
      });
    },
    async takeDue(input) {
      return transaction(() => {
        const work: Awaited<ReturnType<Storage["takeDue"]>>[number][] = [];
        for (const r of (
          db
            .prepare(
              "SELECT record FROM inbound WHERE status='pending' AND json_extract(record,'$.snapshot.endpoint.dispatchMode')='push' AND (json_extract(record,'$.dispatch.lease.expiresAt')<=? OR (json_extract(record,'$.dispatch.lease') IS NULL AND json_extract(record,'$.dispatch.dueAt')<=? AND json_extract(record,'$.dispatch.status') IN ('due','accepted'))) ORDER BY accepted_at,id",
            )
            .all(input.now, input.now) as { record: string }[]
        ).map((x) => decode<InboundRecord>(x.record))) {
          let next = r;
          if (r.dispatch.lease && r.dispatch.lease.expiresAt <= input.now) {
            const dispatch = {
              ...r.dispatch,
              status: "unknown" as const,
              errorCode: "lease_expired",
            };
            delete dispatch.lease;
            next = { ...r, version: r.version + 1, dispatch };
            saveInbound(next);
          }
          if (
            work.length >= input.limit ||
            next.snapshot.endpoint.dispatchMode === "pull" ||
            next.dispatch.status === "unknown" ||
            next.dispatch.status === "rejected" ||
            next.dispatch.lease ||
            next.dispatch.dueAt > input.now ||
            !isEndpointHead(next)
          ) {
            continue;
          }
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: next.version + 1,
            expiresAt: input.now + input.leaseMs,
          };
          next = {
            ...next,
            version: lease.version,
            dispatch: { ...next.dispatch, lease },
          };
          saveInbound(next);
          work.push({ kind: "dispatch", record: next, lease });
        }
        for (const r of (
          db
            .prepare(
              "SELECT record FROM outbound WHERE status='pending' AND (json_extract(record,'$.lease.expiresAt')<=? OR (json_extract(record,'$.lease') IS NULL AND json_extract(record,'$.dueAt')<=?)) ORDER BY id",
            )
            .all(input.now, input.now) as { record: string }[]
        ).map((x) => decode<OutboundRecord>(x.record))) {
          let next = r;
          if (r.lease && r.lease.expiresAt <= input.now) {
            next = {
              ...r,
              version: r.version + 1,
              status: input.safeRetryAccountIds.includes(r.target.accountId)
                ? "pending"
                : "unknown",
              errorCode: "lease_expired",
            };
            next = (({ lease: _lease, ...rest }) => rest)(next);
            saveOutbound(next);
          }
          if (
            work.length >= input.limit ||
            next.status !== "pending" ||
            next.lease ||
            next.dueAt > input.now
          ) {
            continue;
          }
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: next.version + 1,
            expiresAt: input.now + input.leaseMs,
          };
          next = { ...next, version: lease.version, lease };
          saveOutbound(next);
          work.push({ kind: "send", record: next, lease });
        }
        return work;
      });
    },
    async settleAttempt(input) {
      return transaction(() => {
        if (input.kind === "dispatch") {
          const r = inbound(input.id);
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
          saveInbound({ ...r, version: r.version + 1, dispatch });
          return { status: "updated", version: r.version + 1 };
        }
        const r = outbound(input.id);
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
        const outcome = input.outcome;
        const next = {
          ...r,
          version: r.version + 1,
          attempts: r.attempts + 1,
          dueAt: input.nextDueAt,
        };
        delete next.lease;
        delete next.errorCode;
        if (outcome.status === "sent") {
          next.currentChunk++;
          next.attempts = 0;
          next.receipts = [...r.receipts, outcome.receipt];
          next.status = next.currentChunk === next.chunks.length ? "sent" : "pending";
        } else {
          next.status = outcome.status === "retryable" ? "pending" : outcome.status;
          next.errorCode = outcome.errorCode;
        }
        saveOutbound(next);
        return { status: "updated", version: next.version };
      });
    },
  };
}
