import type { Storage, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { decodeDurableRecord } from "./record-codec.js";

export function createInspectionOperations(
  context: Pick<
    DatabaseContext,
    "db" | "transaction" | "readInbound" | "readOutbound" | "saveInbound" | "saveOutbound"
  >,
): Pick<
  Storage,
  "getInbound" | "getOutbound" | "listInbound" | "listOutbound" | "getStats" | "cleanup"
> {
  const { db, transaction, readInbound, readOutbound, saveInbound, saveOutbound } = context;
  return {
    async getInbound(id) {
      return readInbound(id);
    },
    async getOutbound(id) {
      return readOutbound(id);
    },
    async listInbound(filter) {
      const where = ["1=1"];
      const params: (string | number)[] = [];
      if (filter.requestStatus) {
        where.push("status=?");
        params.push(filter.requestStatus);
      }
      if (filter.endpointId) {
        where.push("endpoint=?");
        params.push(filter.endpointId);
      }
      if (filter.afterId) {
        where.push("id>?");
        params.push(filter.afterId);
      }
      return (
        db
          .prepare(`SELECT record FROM inbound WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
          .all(...params, filter.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<InboundRecord>(row.record));
    },
    async listOutbound(filter) {
      const where = ["1=1"];
      const params: (string | number)[] = [];
      if (filter.deliveryStatus) {
        where.push("outbound_delivery.status=?");
        params.push(filter.deliveryStatus);
      }
      if (filter.endpointId) {
        where.push("inbound_request.endpoint=?");
        params.push(filter.endpointId);
      }
      if (filter.afterId) {
        where.push("outbound_delivery.id>?");
        params.push(filter.afterId);
      }
      return (
        db
          .prepare(
            `
              SELECT outbound_delivery.record
              FROM outbound outbound_delivery
              JOIN inbound inbound_request ON inbound_request.id=outbound_delivery.request_id
              WHERE ${where.join(" AND ")}
              ORDER BY outbound_delivery.id
              LIMIT ?
            `,
          )
          .all(...params, filter.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<OutboundRecord>(row.record));
    },
    async getStats() {
      const inboundStats = db
        .prepare(
          `
            SELECT
              SUM(status='pending') pending,
              SUM(status='claimed') claimed,
              MIN(CASE WHEN status='pending' THEN accepted_at END) oldest
            FROM inbound
          `,
        )
        .get() as {
        pending: number | null;
        claimed: number | null;
        oldest: number | null;
      };
      const outboundStats = db
        .prepare(
          "SELECT SUM(status!='sent') undelivered,SUM(status='unknown') unknown FROM outbound",
        )
        .get() as { undelivered: number | null; unknown: number | null };
      const unknownDispatches = db
        .prepare(
          `
            SELECT COUNT(*) count
            FROM inbound
            WHERE status='pending'
              AND json_extract(record,'$.dispatch.status')='unknown'
          `,
        )
        .get() as { count: number };
      return {
        pending: inboundStats.pending ?? 0,
        claimed: inboundStats.claimed ?? 0,
        undelivered: outboundStats.undelivered ?? 0,
        unknown: (outboundStats.unknown ?? 0) + unknownDispatches.count,
        ...(inboundStats.oldest !== null ? { oldestPendingAt: inboundStats.oldest } : {}),
      };
    },
    async cleanup(input) {
      return transaction(() => {
        let redacted = 0;
        const rows = db
          .prepare(
            `
              SELECT inbound_request.record AS inbound_record,outbound_delivery.record AS outbound_record
              FROM inbound inbound_request
              LEFT JOIN outbound outbound_delivery ON outbound_delivery.request_id=inbound_request.id
              WHERE inbound_request.accepted_at<?
                AND json_extract(inbound_request.record,'$.redactedAt') IS NULL
                AND (inbound_request.status='failed'
                  OR (inbound_request.status='completed'
                    AND outbound_delivery.status='sent'))
              ORDER BY inbound_request.accepted_at,inbound_request.id
              LIMIT ?
            `,
          )
          .all(input.before, input.limit) as {
          inbound_record: string;
          outbound_record: string | null;
        }[];
        for (const row of rows) {
          const record = decodeDurableRecord<InboundRecord>(row.inbound_record);
          const delivery = row.outbound_record
            ? decodeDurableRecord<OutboundRecord>(row.outbound_record)
            : undefined;
          saveInbound({
            ...record,
            snapshot: { ...record.snapshot, text: "", context: null },
            ...(record.result ? { result: { ...record.result, text: "" } } : {}),
            redactedAt: input.before,
          });
          if (delivery) {
            saveOutbound({
              ...delivery,
              chunks: delivery.chunks.map((chunk) => ({ ...chunk, text: "", state: null })),
              receipts: delivery.receipts.map(() => ({})),
            });
          }
          redacted++;
        }
        return { redacted };
      });
    },
  };
}
