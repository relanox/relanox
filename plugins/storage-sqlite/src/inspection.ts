import type { Storage, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { decode } from "./record-codec.js";

export function createInspectionOperations(
  context: DatabaseContext,
): Pick<
  Storage,
  "getInbound" | "getOutbound" | "listInbound" | "listOutbound" | "getStats" | "cleanup"
> {
  const { db, transaction, inbound, outbound, saveInbound, saveOutbound } = context;
  return {
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
          .prepare(`SELECT record FROM inbound WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
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
          "SELECT COUNT(*) count FROM inbound WHERE status='pending' AND json_extract(record,'$.dispatch.status')='unknown'",
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
          const o = row.outbound_record ? decode<OutboundRecord>(row.outbound_record) : undefined;
          saveInbound({
            ...r,
            snapshot: { ...r.snapshot, text: "", context: null },
            ...(r.result ? { result: { ...r.result, text: "" } } : {}),
            redactedAt: input.before,
          });
          if (o) {
            saveOutbound({
              ...o,
              chunks: o.chunks.map((c) => ({ ...c, text: "", state: null })),
              receipts: o.receipts.map(() => ({})),
            });
          }
          redacted++;
        }
        return { redacted };
      });
    },
  };
}
