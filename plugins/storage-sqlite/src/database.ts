import type { InboundRecord, OutboundRecord } from "@relanox/sdk";
import Database from "better-sqlite3";
import type { SqliteConfig } from "./config.js";
import { encode, decode } from "./record-codec.js";

/** Owns the connection and atomic transaction boundary for every storage operation. */
export function openDatabase(config: SqliteConfig): DatabaseContext {
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
  const saveInbound = (r: InboundRecord) =>
    db
      .prepare("UPDATE inbound SET status=?, version=?, record=? WHERE id=?")
      .run(r.status, r.version, encode(r), r.snapshot.requestId);
  const saveOutbound = (r: OutboundRecord) =>
    db
      .prepare("UPDATE outbound SET status=?, version=?, record=? WHERE id=?")
      .run(r.status, r.version, encode(r), r.deliveryId);
  const isEndpointHead = (r: InboundRecord): boolean =>
    (
      db
        .prepare(
          "SELECT id FROM inbound WHERE endpoint=? AND status IN ('pending','claimed') ORDER BY CASE WHEN status='claimed' THEN 0 WHEN json_extract(record,'$.dispatch.lease') IS NOT NULL OR json_extract(record,'$.dispatch.attempts')>0 OR json_extract(record,'$.dispatch.status') IN ('unknown','rejected') THEN 1 ELSE 2 END,accepted_at,id LIMIT 1",
        )
        .get(r.snapshot.endpoint.id) as { id: string } | undefined
    )?.id === r.snapshot.requestId;
  return { db, transaction, inbound, outbound, saveInbound, saveOutbound, isEndpointHead };
}

export interface DatabaseContext {
  db: Database.Database;
  transaction<T>(this: void, fn: () => T): T;
  inbound(this: void, id: string): InboundRecord | undefined;
  outbound(this: void, id: string): OutboundRecord | undefined;
  saveInbound(this: void, record: InboundRecord): Database.RunResult;
  saveOutbound(this: void, record: OutboundRecord): Database.RunResult;
  isEndpointHead(this: void, record: InboundRecord): boolean;
}
