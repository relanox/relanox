import { createHash, randomUUID } from "node:crypto";
import type {
  InboundRecord,
  Lease,
  OutboundRecord,
  StateEntry,
  Storage,
  StoragePlugin,
} from "@relanox/sdk";
import Database from "better-sqlite3";
import { z } from "zod";

const configSchema = z
  .object({
    filename: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5000),
  })
  .strict();
export type SqliteConfig = z.infer<typeof configSchema>;
const encode = (v: unknown): string => {
  const ancestors = new Set<object>();
  const check = (x: unknown): void => {
    if (x === null || typeof x === "string" || typeof x === "boolean") return;
    if (typeof x === "number" && Number.isFinite(x)) return;
    if (typeof x !== "object" || !x || ancestors.has(x))
      throw new TypeError("Non-JSON durable value");
    if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype)
      throw new TypeError("Non-plain durable value");
    ancestors.add(x);
    for (const value of Object.values(x)) check(value);
    ancestors.delete(x);
  };
  check(v);
  return JSON.stringify(v);
};
const decode = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown): boolean => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return encode(canonical(a)) === encode(canonical(b));
};
export function createSqliteStorage(config: SqliteConfig): Storage {
  const db = new Database(config.filename);
  db.pragma(`busy_timeout = ${config.busyTimeoutMs}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const transaction = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const inbound = (id: string): InboundRecord | undefined => {
    const r = db.prepare("SELECT record FROM inbound WHERE id=?").get(id) as
      | { record: string }
      | undefined;
    return r ? decode(r.record) : undefined;
  };
  const outbound = (id: string): OutboundRecord | undefined => {
    const r = db.prepare("SELECT record FROM outbound WHERE id=?").get(id) as
      | { record: string }
      | undefined;
    return r ? decode(r.record) : undefined;
  };
  const saveIn = (r: InboundRecord) =>
    db
      .prepare("UPDATE inbound SET status=?, version=?, record=? WHERE id=?")
      .run(r.status, r.version, encode(r), r.snapshot.requestId);
  const saveOut = (r: OutboundRecord) =>
    db
      .prepare("UPDATE outbound SET status=?, version=?, record=? WHERE id=?")
      .run(r.status, r.version, encode(r), r.deliveryId);
  const first = (r: InboundRecord): boolean =>
    (
      db
        .prepare(
          "SELECT id FROM inbound WHERE endpoint=? AND status IN ('pending','claimed') ORDER BY CASE WHEN status='claimed' THEN 0 WHEN json_extract(record,'$.dispatch.lease') IS NOT NULL OR json_extract(record,'$.dispatch.attempts')>0 OR json_extract(record,'$.dispatch.status') IN ('unknown','rejected') THEN 1 ELSE 2 END,accepted_at,id LIMIT 1",
        )
        .get(r.snapshot.endpoint.id) as { id: string } | undefined
    )?.id === r.snapshot.requestId;
  const scoped = (r: InboundRecord, ids: readonly string[]) =>
    ids.includes(r.snapshot.endpoint.id);
  const fence = (a: Lease | undefined, b: Lease, now: number) =>
    !!a && equal(a, b) && a.expiresAt > now;
  const storage: Storage = {
    async migrate() {
      transaction(() => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS migration_metadata(version INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY,channel TEXT NOT NULL,account TEXT NOT NULL,event TEXT NOT NULL,endpoint TEXT NOT NULL,accepted_at INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,final_id TEXT UNIQUE,final_digest TEXT,record TEXT NOT NULL,UNIQUE(channel,account,event)); CREATE INDEX IF NOT EXISTS inbound_fifo ON inbound(endpoint,accepted_at,id); CREATE TABLE IF NOT EXISTS outbound(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES inbound(id),result_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS plugin_state(plugin TEXT NOT NULL,owner TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,expires_at INTEGER,record TEXT NOT NULL,PRIMARY KEY(plugin,owner,key)); INSERT OR IGNORE INTO migration_metadata(version) VALUES(1);`,
        );
      });
    },
    async health() {
      try {
        const r = db
          .prepare("SELECT MAX(version) AS version FROM migration_metadata")
          .get() as { version: number };
        db.prepare("SELECT id,record,final_digest FROM inbound LIMIT 0").all();
        db.prepare("SELECT id,record FROM outbound LIMIT 0").all();
        db.prepare(
          "SELECT plugin,owner,key,version,record FROM plugin_state LIMIT 0",
        ).all();
        return r.version === 1
          ? { ok: true }
          : { ok: false, errorCode: "migration_required" };
      } catch {
        return { ok: false, errorCode: "migration_required" };
      }
    },
    async close() {
      db.close();
    },
    async acceptInbound(snapshot) {
      return transaction(() => {
        const row = db
          .prepare(
            "SELECT id FROM inbound WHERE channel=? AND account=? AND event=?",
          )
          .get(
            snapshot.source.channel,
            snapshot.source.accountId,
            snapshot.source.eventId,
          ) as { id: string } | undefined;
        if (row) return { requestId: row.id, duplicate: true };
        const r: InboundRecord = {
          snapshot: decode(encode(snapshot)),
          status: "pending",
          version: 1,
          dispatch: { status: "due", attempts: 0, dueAt: snapshot.acceptedAt },
        };
        db.prepare(
          "INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          snapshot.requestId,
          snapshot.source.channel,
          snapshot.source.accountId,
          snapshot.source.eventId,
          snapshot.endpoint.id,
          snapshot.acceptedAt,
          r.status,
          1,
          encode(r),
        );
        return { requestId: snapshot.requestId, duplicate: false };
      });
    },
    async listPending(input) {
      if (input.endpointIds.length === 0) return [];
      const placeholders = input.endpointIds.map(() => "?").join(",");
      return (
        db
          .prepare(
            `SELECT record FROM inbound WHERE status='pending' AND endpoint IN (${placeholders}) ORDER BY accepted_at,id LIMIT ?`,
          )
          .all(...input.endpointIds, input.limit) as { record: string }[]
      ).map((x) => decode<InboundRecord>(x.record).snapshot);
    },
    async claimRequest(input) {
      return transaction(() => {
        const r = inbound(input.requestId);
        if (!r || !scoped(r, input.endpointIds)) return { status: "not_found" };
        if (r.status === "claimed")
          return r.claim?.key === input.claimKey
            ? {
                status: "claimed",
                request: r.snapshot,
                claimToken: r.claim.token,
                replay: true,
              }
            : { status: "busy" };
        if (r.status !== "pending") return { status: "not_pending" };
        if (!first(r)) return { status: "busy" };
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        saveIn({
          ...r,
          status: "claimed",
          version: r.version + 1,
          dispatch,
          claim: {
            key: input.claimKey,
            token: input.claimToken,
            claimedAt: input.now,
          },
        });
        return {
          status: "claimed",
          request: r.snapshot,
          claimToken: input.claimToken,
          replay: false,
        };
      });
    },
    async completeAndEnqueue(input) {
      return transaction(() => {
        const r = inbound(input.requestId);
        if (!r) return { status: "not_found" };
        if (
          !scoped(r, input.endpointIds) ||
          r.claim?.token !== input.claimToken
        )
          return { status: "unauthorized" };
        if (r.status === "completed") {
          const row = db
            .prepare("SELECT final_digest FROM inbound WHERE id=?")
            .get(input.requestId) as { final_digest: string };
          const o = db
            .prepare("SELECT id FROM outbound WHERE request_id=?")
            .get(input.requestId) as { id: string };
          return r.result?.resultId === input.result.resultId &&
            row.final_digest === digest(input.result.text)
            ? { status: "completed", deliveryId: o.id, replay: true }
            : { status: "conflict" };
        }
        if (r.status !== "claimed") return { status: "conflict" };
        const o = input.outbound;
        if (
          o.requestId !== input.requestId ||
          o.resultId !== input.result.resultId ||
          !equal(o.target, r.snapshot.target) ||
          o.currentChunk !== 0 ||
          o.receipts.length !== 0 ||
          o.status !== "pending" ||
          o.version !== 1 ||
          o.attempts !== 0 ||
          o.lease ||
          o.chunks.length === 0 ||
          o.chunks.map((c) => c.text).join("") !== input.result.text
        )
          return { status: "conflict" };
        if (
          db
            .prepare("SELECT id FROM inbound WHERE final_id=?")
            .get(input.result.resultId) ||
          db.prepare("SELECT id FROM outbound WHERE id=?").get(o.deliveryId)
        )
          return { status: "conflict" };
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        db.prepare(
          "INSERT INTO outbound(id,request_id,result_id,status,version,record) VALUES(?,?,?,?,?,?)",
        ).run(o.deliveryId, o.requestId, o.resultId, o.status, 1, encode(o));
        saveIn({
          ...r,
          status: "completed",
          version: r.version + 1,
          result: input.result,
          dispatch,
        });
        db.prepare(
          "UPDATE inbound SET final_id=?,final_digest=? WHERE id=?",
        ).run(
          input.result.resultId,
          digest(input.result.text),
          input.requestId,
        );
        return { status: "completed", deliveryId: o.deliveryId, replay: false };
      });
    },
    async fail(input) {
      return transaction(() => {
        const r = inbound(input.requestId);
        if (!r) return { status: "not_found" };
        if (
          !scoped(r, input.endpointIds) ||
          r.claim?.token !== input.claimToken
        )
          return { status: "unauthorized" };
        if (r.status === "failed" && r.errorCode === input.errorCode)
          return { status: "updated", version: r.version };
        if (r.status !== "claimed") return { status: "conflict" };
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        saveIn({
          ...r,
          status: "failed",
          version: r.version + 1,
          errorCode: input.errorCode,
          dispatch,
        });
        return { status: "updated", version: r.version + 1 };
      });
    },
    async requeue(input) {
      return transaction(() => {
        if (input.kind === "request") {
          const r = inbound(input.id);
          if (!r) return { status: "not_found" };
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
          )
            return { status: "conflict" };
          const next = {
            ...r,
            status: "pending" as const,
            version: r.version + 1,
            dispatch: { status: "due" as const, attempts: 0, dueAt: input.now },
          };
          delete next.claim;
          delete next.errorCode;
          saveIn(next);
          return { status: "updated", version: next.version };
        }
        const r = outbound(input.id);
        if (!r) return { status: "not_found" };
        if (
          r.version !== input.expectedVersion ||
          !["rejected", "unknown"].includes(r.status) ||
          (r.status === "unknown" && !input.acknowledgeUnknown)
        )
          return { status: "conflict" };
        const next = {
          ...r,
          status: "pending" as const,
          version: r.version + 1,
          dueAt: input.now,
        };
        delete next.lease;
        delete next.errorCode;
        saveOut(next);
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
            saveIn(next);
          }
          if (
            work.length >= input.limit ||
            next.snapshot.endpoint.dispatchMode === "pull" ||
            next.dispatch.status === "unknown" ||
            next.dispatch.status === "rejected" ||
            next.dispatch.lease ||
            next.dispatch.dueAt > input.now ||
            !first(next)
          )
            continue;
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
          saveIn(next);
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
            saveOut(next);
          }
          if (
            work.length >= input.limit ||
            next.status !== "pending" ||
            next.lease ||
            next.dueAt > input.now
          )
            continue;
          const lease = {
            token: `${input.leaseOwner}:${randomUUID()}`,
            version: next.version + 1,
            expiresAt: input.now + input.leaseMs,
          };
          next = { ...next, version: lease.version, lease };
          saveOut(next);
          work.push({ kind: "send", record: next, lease });
        }
        return work;
      });
    },
    async settleAttempt(input) {
      return transaction(() => {
        if (input.kind === "dispatch") {
          const r = inbound(input.id);
          if (!r) return { status: "not_found" };
          if (
            r.status !== "pending" ||
            r.version !== input.lease.version ||
            !fence(r.dispatch.lease, input.lease, input.now)
          )
            return { status: "conflict" };
          const outcome = input.outcome;
          const dispatch = {
            status:
              outcome.status === "retryable"
                ? ("due" as const)
                : outcome.status,
            attempts: r.dispatch.attempts + 1,
            dueAt: input.nextDueAt,
            ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {}),
          };
          saveIn({ ...r, version: r.version + 1, dispatch });
          return { status: "updated", version: r.version + 1 };
        }
        const r = outbound(input.id);
        if (!r) return { status: "not_found" };
        if (
          r.status !== "pending" ||
          r.version !== input.lease.version ||
          !fence(r.lease, input.lease, input.now)
        )
          return { status: "conflict" };
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
          next.status =
            next.currentChunk === next.chunks.length ? "sent" : "pending";
        } else {
          next.status =
            outcome.status === "retryable" ? "pending" : outcome.status;
          next.errorCode = outcome.errorCode;
        }
        saveOut(next);
        return { status: "updated", version: next.version };
      });
    },
    async getState(ns, key) {
      const row = db
        .prepare(
          "SELECT record FROM plugin_state WHERE plugin=? AND owner=? AND key=?",
        )
        .get(ns.pluginId, ns.ownerId, key) as { record: string } | undefined;
      return row ? decode<StateEntry>(row.record) : undefined;
    },
    async listState(ns, input) {
      const where = ["plugin=?", "owner=?"];
      const params: (string | number)[] = [ns.pluginId, ns.ownerId];
      if (input.prefix !== undefined) {
        where.push("substr(key,1,?)=?");
        params.push(input.prefix.length, input.prefix);
      }
      if (input.expiresBefore !== undefined) {
        where.push("expires_at<=?");
        params.push(input.expiresBefore);
      }
      return (
        db
          .prepare(
            `SELECT record FROM plugin_state WHERE ${where.join(" AND ")} ORDER BY key LIMIT ?`,
          )
          .all(...params, input.limit) as { record: string }[]
      ).map((x) => decode<StateEntry>(x.record));
    },
    async compareAndSetState(ns, input) {
      return transaction(() => {
        const old = db
          .prepare(
            "SELECT version FROM plugin_state WHERE plugin=? AND owner=? AND key=?",
          )
          .get(ns.pluginId, ns.ownerId, input.key) as
          | { version: number }
          | undefined;
        if (
          input.expectedVersion === null
            ? !!old
            : old?.version !== input.expectedVersion
        )
          return { status: "conflict" };
        const version = (old?.version ?? 0) + 1;
        const entry: StateEntry = {
          key: input.key,
          value: input.value,
          version,
          ...(input.expiresAt !== undefined
            ? { expiresAt: input.expiresAt }
            : {}),
        };
        db.prepare(
          "INSERT INTO plugin_state(plugin,owner,key,version,expires_at,record) VALUES(?,?,?,?,?,?) ON CONFLICT(plugin,owner,key) DO UPDATE SET version=excluded.version,expires_at=excluded.expires_at,record=excluded.record",
        ).run(
          ns.pluginId,
          ns.ownerId,
          input.key,
          version,
          input.expiresAt ?? null,
          encode(entry),
        );
        return { status: "updated", version };
      });
    },
    async deleteState(ns, key, version) {
      return transaction(() => {
        const old = db
          .prepare(
            "SELECT version FROM plugin_state WHERE plugin=? AND owner=? AND key=?",
          )
          .get(ns.pluginId, ns.ownerId, key) as { version: number } | undefined;
        if (!old) return { status: "not_found" };
        if (old.version !== version) return { status: "conflict" };
        db.prepare(
          "DELETE FROM plugin_state WHERE plugin=? AND owner=? AND key=?",
        ).run(ns.pluginId, ns.ownerId, key);
        return { status: "updated", version: version + 1 };
      });
    },
    async getInbound(id) {
      return inbound(id);
    },
    async getOutbound(id) {
      return outbound(id);
    },
    async listInbound(f) {
      const where = ["1=1"];
      const params: (string | number)[] = [];
      if (f.requestStatus) {
        where.push("status=?");
        params.push(f.requestStatus);
      }
      if (f.endpointId) {
        where.push("endpoint=?");
        params.push(f.endpointId);
      }
      if (f.afterId) {
        where.push("id>?");
        params.push(f.afterId);
      }
      return (
        db
          .prepare(
            `SELECT record FROM inbound WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
          )
          .all(...params, f.limit) as { record: string }[]
      ).map((x) => decode<InboundRecord>(x.record));
    },
    async listOutbound(f) {
      const where = ["1=1"];
      const params: (string | number)[] = [];
      if (f.deliveryStatus) {
        where.push("o.status=?");
        params.push(f.deliveryStatus);
      }
      if (f.endpointId) {
        where.push("i.endpoint=?");
        params.push(f.endpointId);
      }
      if (f.afterId) {
        where.push("o.id>?");
        params.push(f.afterId);
      }
      return (
        db
          .prepare(
            `SELECT o.record FROM outbound o JOIN inbound i ON i.id=o.request_id WHERE ${where.join(" AND ")} ORDER BY o.id LIMIT ?`,
          )
          .all(...params, f.limit) as { record: string }[]
      ).map((x) => decode<OutboundRecord>(x.record));
    },
    async getStats() {
      const a = db
        .prepare(
          "SELECT SUM(status='pending') pending,SUM(status='claimed') claimed,MIN(CASE WHEN status='pending' THEN accepted_at END) oldest FROM inbound",
        )
        .get() as {
        pending: number | null;
        claimed: number | null;
        oldest: number | null;
      };
      const b = db
        .prepare(
          "SELECT SUM(status!='sent') undelivered,SUM(status='unknown') unknown FROM outbound",
        )
        .get() as { undelivered: number | null; unknown: number | null };
      const c = db
        .prepare(
          "SELECT COUNT(*) count FROM inbound WHERE json_extract(record,'$.dispatch.status')='unknown'",
        )
        .get() as { count: number };
      return {
        pending: a.pending ?? 0,
        claimed: a.claimed ?? 0,
        undelivered: b.undelivered ?? 0,
        unknown: (b.unknown ?? 0) + c.count,
        ...(a.oldest !== null ? { oldestPendingAt: a.oldest } : {}),
      };
    },
    async cleanup(input) {
      return transaction(() => {
        let redacted = 0;
        const rows = db
          .prepare(
            "SELECT i.record AS inbound_record,o.record AS outbound_record FROM inbound i LEFT JOIN outbound o ON o.request_id=i.id WHERE i.accepted_at<? AND json_extract(i.record,'$.redactedAt') IS NULL AND (i.status='failed' OR (i.status='completed' AND o.status='sent')) ORDER BY i.accepted_at,i.id LIMIT ?",
          )
          .all(input.before, input.limit) as {
          inbound_record: string;
          outbound_record: string | null;
        }[];
        for (const row of rows) {
          const r = decode<InboundRecord>(row.inbound_record);
          const o = row.outbound_record
            ? decode<OutboundRecord>(row.outbound_record)
            : undefined;
          saveIn({
            ...r,
            snapshot: { ...r.snapshot, text: "", context: null },
            ...(r.result ? { result: { ...r.result, text: "" } } : {}),
            redactedAt: input.before,
          });
          if (o)
            saveOut({
              ...o,
              chunks: o.chunks.map((c) => ({ ...c, text: "", state: null })),
              receipts: o.receipts.map(() => ({})),
            });
          redacted++;
        }
        return { redacted };
      });
    },
  };
  return storage;
}
export const sqliteStoragePlugin: StoragePlugin<SqliteConfig> = {
  id: "sqlite",
  kind: "storage",
  sdkMajor: 1,
  runtime: "node",
  validateConfig: (input) => configSchema.parse(input),
  async setup(config) {
    return createSqliteStorage(config);
  },
};
