import type { InboundRecord, OutboundRecord, Observability, Span } from "@relanox/sdk";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type { z } from "zod";
import { configSchema } from "./config.js";
import { encode } from "./record-codec.js";

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(configuration: z.input<typeof configSchema>, observe: Observability) {
  const extractDatabaseErrorCode = (error: unknown): string | undefined =>
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
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
          if (
            !discard &&
            attempt < 7 &&
            ["40001", "40P01"].includes(extractDatabaseErrorCode(error) ?? "")
          ) {
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
  const readInbound = async (
    client: Pool | PoolClient,
    id: string,
  ): Promise<InboundRecord | undefined> =>
    (
      await query<{ record: InboundRecord }>(client, "SELECT record FROM inbound WHERE id=$1", [id])
    )[0]?.record;
  const readOutbound = async (
    client: Pool | PoolClient,
    id: string,
  ): Promise<OutboundRecord | undefined> =>
    (
      await query<{ record: OutboundRecord }>(client, "SELECT record FROM outbound WHERE id=$1", [
        id,
      ])
    )[0]?.record;
  const saveInbound = async (
    client: PoolClient,
    record: InboundRecord,
    expectedVersion = record.version - 1,
  ) => {
    const changed = await client.query(
      "UPDATE inbound SET status=$1,version=$2,record=$3::jsonb WHERE id=$4 AND version=$5",
      [record.status, record.version, encode(record), record.snapshot.requestId, expectedVersion],
    );
    if (changed.rowCount !== 1) {
      throw new Error("Inbound version conflict");
    }
  };
  const saveOutbound = async (
    client: PoolClient,
    record: OutboundRecord,
    expectedVersion = record.version - 1,
  ) => {
    const changed = await client.query(
      "UPDATE outbound SET status=$1,version=$2,record=$3::jsonb WHERE id=$4 AND version=$5",
      [record.status, record.version, encode(record), record.deliveryId, expectedVersion],
    );
    if (changed.rowCount !== 1) {
      throw new Error("Outbound version conflict");
    }
  };
  const isEndpointHead = async (client: PoolClient, record: InboundRecord) =>
    (
      await query(
        client,
        `
          SELECT id
          FROM inbound
          WHERE endpoint=$1
            AND id<>$3
            AND status IN ('pending','claimed')
            AND (status='claimed'
              OR record#>'{dispatch,lease}' IS NOT NULL
              OR (record#>>'{dispatch,attempts}')::int>0
              OR record#>>'{dispatch,status}' IN ('unknown','rejected')
              OR (NOT $4
                AND (accepted_at,id)<($2,$3)))
          LIMIT 1
        `,
        [
          record.snapshot.endpoint.id,
          record.snapshot.acceptedAt,
          record.snapshot.requestId,
          Boolean(record.dispatch.lease) ||
            record.dispatch.attempts > 0 ||
            ["unknown", "rejected"].includes(record.dispatch.status),
        ],
      )
    ).length === 0;
  return {
    config,
    pool,
    query,
    transaction,
    readInbound,
    readOutbound,
    saveInbound,
    saveOutbound,
    isEndpointHead,
  };
}

export type DatabaseContext = ReturnType<typeof openDatabase>;

export const boundedLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("Invalid storage limit");
  }
  return Math.min(limit, 1000);
};
