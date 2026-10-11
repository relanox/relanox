import { createHash, randomUUID } from "node:crypto";
import type {
  DueWork,
  InboundRecord,
  Lease,
  Observability,
  OutboundRecord,
  Span,
  StateEntry,
  Storage,
  StoragePlugin,
} from "@relanox/sdk";
import { noopObservability } from "@relanox/sdk";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";

const configSchema = z
  .object({
    connectionString: z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) }).strict(),
    schema: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/u)
      .default("public"),
    maxConnections: z.number().int().min(1).max(100).default(10),
    connectionTimeoutMs: z.number().int().min(1).max(300_000).default(5000),
    idleTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    statementTimeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  })
  .strict();
export type PostgresConfig = z.infer<typeof configSchema>;

const encode = (v: unknown): string => {
  const ancestors = new Set<object>();
  const check = (x: unknown): void => {
    if (x === null || typeof x === "string" || typeof x === "boolean") {
      return;
    }
    if (typeof x === "number" && Number.isFinite(x)) {
      return;
    }
    if (typeof x !== "object" || ancestors.has(x)) {
      throw new TypeError("Non-JSON durable value");
    }
    if (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype) {
      throw new TypeError("Non-plain durable value");
    }
    ancestors.add(x);
    for (const value of Object.values(x)) {
      check(value);
    }
    ancestors.delete(x);
  };
  check(v);
  return JSON.stringify(v);
};
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown): boolean => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return encode(canonical(a)) === encode(canonical(b));
};
const code = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const bounded = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("Invalid storage limit");
  }
  return Math.min(limit, 1000);
};

/** Secrets resolve at pool construction; validated config retains only the environment reference. */
function matchesResult(
  outbound: OutboundRecord,
  request: InboundRecord,
  input: Parameters<Storage["completeAndEnqueue"]>[0],
): boolean {
  return (
    outbound.requestId === input.requestId &&
    outbound.resultId === input.result.resultId &&
    equal(outbound.target, request.snapshot.target) &&
    outbound.currentChunk === 0 &&
    outbound.receipts.length === 0 &&
    outbound.status === "pending" &&
    outbound.version === 1 &&
    outbound.attempts === 0 &&
    outbound.lease === undefined &&
    outbound.chunks.length > 0 &&
    outbound.chunks.map((chunk) => chunk.text).join("") === input.result.text
  );
}
export function createPostgresStorage(
  configuration: z.input<typeof configSchema>,
  observe: Observability = noopObservability,
): Storage {
  const config = configSchema.parse(configuration);
  const connectionString = process.env[config.connectionString.env];
  if (!connectionString) {
    throw new Error("PostgreSQL connection secret is unavailable");
  }
  const pool = new Pool({
    connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    options: `-c search_path=${config.schema} -c idle_in_transaction_session_timeout=${config.statementTimeoutMs}`,
  });
  // An idle socket failure must not become an unhandled EventEmitter error.
  pool.on("error", () => {
    try {
      observe.log("error", "storage.failed", {
        plugin: "storage-postgres",
        errorCode: "unavailable",
      });
    } catch {
      /* Telemetry is best effort */
    }
  });
  const query = async <T extends QueryResultRow>(
    client: Pool | PoolClient,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> => (await client.query<T>(sql, values)).rows;
  const transaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const started = performance.now();
    let span: Span | undefined;
    try {
      span = observe.span("storage", {
        plugin: "storage-postgres",
        operation: "storage",
      });
    } catch {
      /* Telemetry is best effort */
    }
    let outcome: "ok" | "error" = "error";
    try {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        let discard = false;
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          const result = await fn(client);
          await client.query("COMMIT");
          outcome = "ok";
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            discard = true;
          }
          if (!discard && attempt < 7 && ["40001", "40P01"].includes(code(error) ?? "")) {
            continue;
          }
          throw error;
        } finally {
          client.release(discard);
        }
      }
    } finally {
      try {
        span?.end(outcome);
      } catch {
        /* Telemetry is best effort */
      }
      try {
        observe.record("relanox_storage_duration_seconds", (performance.now() - started) / 1000, {
          plugin: "storage-postgres",
          operation: "storage",
          outcome,
        });
      } catch {
        /* Telemetry is best effort */
      }
    }
  };
  const inbound = async (
    client: Pool | PoolClient,
    id: string,
  ): Promise<InboundRecord | undefined> =>
    (
      await query<{ record: InboundRecord }>(client, "SELECT record FROM inbound WHERE id=$1", [id])
    )[0]?.record;
  const outbound = async (
    client: Pool | PoolClient,
    id: string,
  ): Promise<OutboundRecord | undefined> =>
    (
      await query<{ record: OutboundRecord }>(client, "SELECT record FROM outbound WHERE id=$1", [
        id,
      ])
    )[0]?.record;
  const saveIn = async (client: PoolClient, r: InboundRecord, expectedVersion = r.version - 1) => {
    const changed = await client.query(
      "UPDATE inbound SET status=$1,version=$2,record=$3::jsonb WHERE id=$4 AND version=$5",
      [r.status, r.version, encode(r), r.snapshot.requestId, expectedVersion],
    );
    if (changed.rowCount !== 1) {
      throw new Error("Inbound version conflict");
    }
  };
  const saveOut = async (
    client: PoolClient,
    r: OutboundRecord,
    expectedVersion = r.version - 1,
  ) => {
    const changed = await client.query(
      "UPDATE outbound SET status=$1,version=$2,record=$3::jsonb WHERE id=$4 AND version=$5",
      [r.status, r.version, encode(r), r.deliveryId, expectedVersion],
    );
    if (changed.rowCount !== 1) {
      throw new Error("Outbound version conflict");
    }
  };
  const first = async (client: PoolClient, r: InboundRecord) =>
    (
      await query(
        client,
        "SELECT id FROM inbound WHERE endpoint=$1 AND id<>$3 AND status IN ('pending','claimed') AND (status='claimed' OR record#>'{dispatch,lease}' IS NOT NULL OR (record#>>'{dispatch,attempts}')::int>0 OR record#>>'{dispatch,status}' IN ('unknown','rejected') OR (NOT $4 AND (accepted_at,id)<($2,$3))) LIMIT 1",
        [
          r.snapshot.endpoint.id,
          r.snapshot.acceptedAt,
          r.snapshot.requestId,
          Boolean(r.dispatch.lease) ||
            r.dispatch.attempts > 0 ||
            ["unknown", "rejected"].includes(r.dispatch.status),
        ],
      )
    ).length === 0;
  const scoped = (
    r: InboundRecord,
    input: Pick<Parameters<Storage["claimRequest"]>[0], "endpointIds" | "agent">,
  ) =>
    input.endpointIds.includes(r.snapshot.endpoint.id) && r.snapshot.endpoint.agent === input.agent;
  const fence = (a: Lease | undefined, b: Lease, now: number) =>
    a !== undefined && equal(a, b) && a.expiresAt > now;
  const storage: Storage = {
    async initialize() {
      await transaction(async (client) => {
        // Serialize concurrent startup; schema is a validated PostgreSQL identifier.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `relanox:initialize:${config.schema}`,
        ]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS inbound(
            id TEXT COLLATE "C" PRIMARY KEY, channel TEXT NOT NULL, account TEXT NOT NULL,event TEXT NOT NULL,
            endpoint TEXT NOT NULL,accepted_at BIGINT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,
            final_id TEXT UNIQUE,final_digest TEXT,record JSONB NOT NULL,UNIQUE(channel,account,event));
          CREATE INDEX IF NOT EXISTS inbound_fifo ON inbound(endpoint,accepted_at,id) WHERE status IN ('pending','claimed');
          CREATE INDEX IF NOT EXISTS inbound_due ON inbound(((record#>>'{dispatch,dueAt}')::bigint),accepted_at,id) WHERE status='pending';
          CREATE INDEX IF NOT EXISTS inbound_lease ON inbound(((record#>>'{dispatch,lease,expiresAt}')::bigint)) WHERE status='pending';
          CREATE TABLE IF NOT EXISTS outbound(
            id TEXT COLLATE "C" PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES inbound(id),
            result_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,version INTEGER NOT NULL,record JSONB NOT NULL);
          CREATE INDEX IF NOT EXISTS outbound_due ON outbound(((record->>'dueAt')::bigint),id) WHERE status='pending';
          CREATE INDEX IF NOT EXISTS outbound_lease ON outbound(((record#>>'{lease,expiresAt}')::bigint)) WHERE status='pending';
          CREATE TABLE IF NOT EXISTS plugin_state(
            plugin TEXT NOT NULL,owner TEXT NOT NULL,key TEXT COLLATE "C" NOT NULL,version INTEGER NOT NULL,
            expires_at BIGINT,record JSONB NOT NULL,PRIMARY KEY(plugin,owner,key));
        `);
      });
    },
    async health() {
      try {
        await pool.query("SELECT id,record,final_digest FROM inbound LIMIT 0");
        await pool.query("SELECT id,record FROM outbound LIMIT 0");
        await pool.query("SELECT plugin,owner,key,version,record FROM plugin_state LIMIT 0");
        return { ok: true };
      } catch {
        return { ok: false, errorCode: "storage_unavailable" };
      }
    },
    async close() {
      await pool.end();
    },
    async acceptInbound(snapshot) {
      return transaction(async (client) => {
        const existing = (
          await query<{ id: string }>(
            client,
            "SELECT id FROM inbound WHERE channel=$1 AND account=$2 AND event=$3",
            [snapshot.source.channel, snapshot.source.accountId, snapshot.source.eventId],
          )
        )[0];
        if (existing) {
          return { requestId: existing.id, duplicate: true };
        }
        const r: InboundRecord = {
          snapshot,
          status: "pending",
          version: 1,
          dispatch: { status: "due", attempts: 0, dueAt: snapshot.acceptedAt },
        };
        const inserted = await query<{ id: string }>(
          client,
          "INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(channel,account,event) DO NOTHING RETURNING id",
          [
            snapshot.requestId,
            snapshot.source.channel,
            snapshot.source.accountId,
            snapshot.source.eventId,
            snapshot.endpoint.id,
            snapshot.acceptedAt,
            r.status,
            1,
            encode(r),
          ],
        );
        if (inserted.length > 0) {
          return { requestId: snapshot.requestId, duplicate: false };
        }
        const original = (
          await query<{ id: string }>(
            client,
            "SELECT id FROM inbound WHERE channel=$1 AND account=$2 AND event=$3",
            [snapshot.source.channel, snapshot.source.accountId, snapshot.source.eventId],
          )
        )[0];
        if (!original) {
          throw new Error("Concurrent source key is unavailable");
        }
        return { requestId: original.id, duplicate: true };
      });
    },
    async listPending(input) {
      return (
        await query<{ record: InboundRecord }>(
          pool,
          "SELECT record FROM inbound WHERE status='pending' AND endpoint=ANY($1::text[]) AND record#>>'{snapshot,endpoint,agent}'=$3 ORDER BY accepted_at,id LIMIT $2",
          [input.endpointIds, bounded(input.limit), input.agent],
        )
      ).map((r) => r.record.snapshot);
    },
    async claimRequest(input) {
      return transaction(async (client) => {
        const r = await inbound(client, input.requestId);
        if (!r || !scoped(r, input)) {
          return { status: "not_found" };
        }
        if (r.status === "claimed") {
          return r.claim?.key === input.claimKey
            ? {
                status: "claimed",
                request: r.snapshot,
                claimToken: r.claim.token,
                replay: true,
              }
            : { status: "busy" };
        }
        if (r.status !== "pending") {
          return { status: "not_pending" };
        }
        if (!(await first(client, r))) {
          return { status: "busy" };
        }
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        await saveIn(client, {
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
      return transaction(async (client) => {
        const r = await inbound(client, input.requestId);
        if (!r) {
          return { status: "not_found" };
        }
        if (!scoped(r, input) || r.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (r.status === "completed") {
          const row = (
            await query<{ final_digest: string }>(
              client,
              "SELECT final_digest FROM inbound WHERE id=$1",
              [input.requestId],
            )
          )[0];
          const o = (
            await query<{ id: string }>(client, "SELECT id FROM outbound WHERE request_id=$1", [
              input.requestId,
            ])
          )[0];
          return r.result?.resultId === input.result.resultId &&
            row?.final_digest === digest(input.result.text) &&
            o
            ? { status: "completed", deliveryId: o.id, replay: true }
            : { status: "conflict" };
        }
        if (r.status !== "claimed") {
          return { status: "conflict" };
        }
        const o = input.outbound;
        if (!matchesResult(o, r, input)) {
          return { status: "conflict" };
        }
        const inserted = await query(
          client,
          "INSERT INTO outbound(id,request_id,result_id,status,version,record) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id",
          [o.deliveryId, o.requestId, o.resultId, o.status, 1, encode(o)],
        );
        if (inserted.length === 0) {
          return { status: "conflict" };
        }
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        await saveIn(client, {
          ...r,
          status: "completed",
          version: r.version + 1,
          result: input.result,
          dispatch,
        });
        await client.query(
          "UPDATE inbound SET final_id=$1,final_digest=$2 WHERE id=$3 AND version=$4",
          [input.result.resultId, digest(input.result.text), input.requestId, r.version + 1],
        );
        return { status: "completed", deliveryId: o.deliveryId, replay: false };
      });
    },
    async fail(input) {
      return transaction(async (client) => {
        const r = await inbound(client, input.requestId);
        if (!r) {
          return { status: "not_found" };
        }
        if (!scoped(r, input) || r.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (r.status === "failed" && r.errorCode === input.errorCode) {
          return { status: "updated", version: r.version };
        }
        if (r.status !== "claimed") {
          return { status: "conflict" };
        }
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        await saveIn(client, {
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
          await saveIn(client, next);
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
        await saveOut(client, next);
        return { status: "updated", version: next.version };
      });
    },
    async takeDue(input) {
      const limit = bounded(input.limit);
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
          await saveIn(client, { ...r, version: r.version + 1, dispatch });
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
          await saveOut(client, next);
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
          await saveIn(client, next);
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
          await saveOut(client, next);
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
            !fence(r.dispatch.lease, input.lease, input.now)
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
          await saveIn(client, { ...r, version: r.version + 1, dispatch });
          return { status: "updated", version: r.version + 1 };
        }
        const r = await outbound(client, input.id);
        if (!r) {
          return { status: "not_found" };
        }
        if (
          r.status !== "pending" ||
          r.version !== input.lease.version ||
          !fence(r.lease, input.lease, input.now)
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
        await saveOut(client, next);
        return { status: "updated", version: next.version };
      });
    },
    async getState(ns, key) {
      return (
        await query<{ record: StateEntry }>(
          pool,
          "SELECT record FROM plugin_state WHERE plugin=$1 AND owner=$2 AND key=$3 AND record!='null'::jsonb",
          [ns.pluginId, ns.ownerId, key],
        )
      )[0]?.record;
    },
    async listState(ns, input) {
      const params: unknown[] = [ns.pluginId, ns.ownerId];
      const where = ["plugin=$1", "owner=$2", "record!='null'::jsonb"];
      if (input.prefix !== undefined) {
        params.push(input.prefix);
        where.push(`starts_with(key,$${params.length})`);
      }
      if (input.expiresBefore !== undefined) {
        params.push(input.expiresBefore);
        where.push(`expires_at<=$${params.length}`);
      }
      params.push(bounded(input.limit));
      return (
        await query<{ record: StateEntry }>(
          pool,
          `SELECT record FROM plugin_state WHERE ${where.join(" AND ")} ORDER BY key LIMIT $${params.length}`,
          params,
        )
      ).map((r) => r.record);
    },
    async compareAndSetState(ns, input) {
      return transaction(async (client) => {
        const old = (
          await query<{ version: number; active: boolean }>(
            client,
            "SELECT version,record!='null'::jsonb AS active FROM plugin_state WHERE plugin=$1 AND owner=$2 AND key=$3",
            [ns.pluginId, ns.ownerId, input.key],
          )
        )[0];
        if (
          input.expectedVersion === null
            ? old?.active
            : !old?.active || old.version !== input.expectedVersion
        ) {
          return { status: "conflict" };
        }
        const version = (old?.version ?? 0) + 1;
        const entry: StateEntry = {
          key: input.key,
          value: input.value,
          version,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        };
        const params = [
          ns.pluginId,
          ns.ownerId,
          input.key,
          version,
          input.expiresAt ?? null,
          encode(entry),
        ];
        const changed = !old
          ? await query(
              client,
              "INSERT INTO plugin_state(plugin,owner,key,version,expires_at,record) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING version",
              params,
            )
          : await query(
              client,
              "UPDATE plugin_state SET version=$4,expires_at=$5,record=$6::jsonb WHERE plugin=$1 AND owner=$2 AND key=$3 AND version=$7 RETURNING version",
              [...params, old.version],
            );
        return changed.length > 0 ? { status: "updated", version } : { status: "conflict" };
      });
    },
    async deleteState(ns, key, version) {
      return transaction(async (client) => {
        const old = (
          await query<{ version: number }>(
            client,
            "SELECT version FROM plugin_state WHERE plugin=$1 AND owner=$2 AND key=$3 AND record!='null'::jsonb",
            [ns.pluginId, ns.ownerId, key],
          )
        )[0];
        if (!old) {
          return { status: "not_found" };
        }
        if (old.version !== version) {
          return { status: "conflict" };
        }
        await client.query(
          "UPDATE plugin_state SET record='null'::jsonb,expires_at=NULL,version=version+1 WHERE plugin=$1 AND owner=$2 AND key=$3 AND version=$4",
          [ns.pluginId, ns.ownerId, key, version],
        );
        return { status: "updated", version: version + 1 };
      });
    },
    async getInbound(id) {
      return inbound(pool, id);
    },
    async getOutbound(id) {
      return outbound(pool, id);
    },
    async listInbound(f) {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (f.requestStatus !== undefined) {
        params.push(f.requestStatus);
        where.push(`status=$${params.length}`);
      }
      if (f.endpointId !== undefined) {
        params.push(f.endpointId);
        where.push(`endpoint=$${params.length}`);
      }
      if (f.afterId !== undefined) {
        params.push(f.afterId);
        where.push(`id>$${params.length}`);
      }
      params.push(bounded(f.limit));
      return (
        await query<{ record: InboundRecord }>(
          pool,
          `SELECT record FROM inbound WHERE ${where.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
          params,
        )
      ).map((r) => r.record);
    },
    async listOutbound(f) {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (f.deliveryStatus !== undefined) {
        params.push(f.deliveryStatus);
        where.push(`o.status=$${params.length}`);
      }
      if (f.endpointId !== undefined) {
        params.push(f.endpointId);
        where.push(`i.endpoint=$${params.length}`);
      }
      if (f.afterId !== undefined) {
        params.push(f.afterId);
        where.push(`o.id>$${params.length}`);
      }
      params.push(bounded(f.limit));
      return (
        await query<{ record: OutboundRecord }>(
          pool,
          `SELECT o.record FROM outbound o JOIN inbound i ON i.id=o.request_id WHERE ${where.join(" AND ")} ORDER BY o.id LIMIT $${params.length}`,
          params,
        )
      ).map((r) => r.record);
    },
    async getStats() {
      const row = (
        await query<{
          pending: string;
          claimed: string;
          oldest: string | null;
          undelivered: string;
          unknown: string;
        }>(
          pool,
          `
        SELECT COUNT(*) FILTER(WHERE status='pending') pending,COUNT(*) FILTER(WHERE status='claimed') claimed,
          MIN(accepted_at) FILTER(WHERE status='pending') oldest,
          (SELECT COUNT(*) FROM outbound WHERE status!='sent') undelivered,
          COUNT(*) FILTER(WHERE status='pending' AND record#>>'{dispatch,status}'='unknown')+(SELECT COUNT(*) FROM outbound WHERE status='unknown') unknown FROM inbound`,
        )
      )[0];
      if (!row) {
        throw new Error("Storage aggregates unavailable");
      }
      return {
        pending: Number(row.pending),
        claimed: Number(row.claimed),
        undelivered: Number(row.undelivered),
        unknown: Number(row.unknown),
        ...(row.oldest !== null ? { oldestPendingAt: Number(row.oldest) } : {}),
      };
    },
    async cleanup(input) {
      return transaction(async (client) => {
        const rows = await query<{
          inbound_record: InboundRecord;
          outbound_record: OutboundRecord | null;
        }>(
          client,
          `
          SELECT i.record inbound_record,o.record outbound_record FROM inbound i LEFT JOIN outbound o ON o.request_id=i.id
          WHERE i.accepted_at<$1 AND i.record->'redactedAt' IS NULL AND (i.status='failed' OR (i.status='completed' AND o.status='sent'))
          ORDER BY i.accepted_at,i.id LIMIT $2`,
          [input.before, bounded(input.limit)],
        );
        for (const { inbound_record: r, outbound_record: o } of rows) {
          await saveIn(
            client,
            {
              ...r,
              snapshot: { ...r.snapshot, text: "", context: null },
              ...(r.result ? { result: { ...r.result, text: "" } } : {}),
              redactedAt: input.before,
            },
            r.version,
          );
          if (o) {
            await saveOut(
              client,
              {
                ...o,
                chunks: o.chunks.map((c) => ({ ...c, text: "", state: null })),
                receipts: o.receipts.map(() => ({})),
              },
              o.version,
            );
          }
        }
        return { redacted: rows.length };
      });
    },
  };
  return storage;
}
export const postgresStoragePlugin: StoragePlugin<PostgresConfig> = {
  id: "postgres",
  kind: "storage",
  sdkMajor: 1,
  runtime: "node",
  validateConfig: (input) => configSchema.parse(input),
  async setup(config, observe) {
    return createPostgresStorage(config, observe);
  },
};
