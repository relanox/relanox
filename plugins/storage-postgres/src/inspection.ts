import type { Storage, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { boundedLimit } from "./database.js";

export function createInspectionOperations(
  context: DatabaseContext,
): Pick<
  Storage,
  "getInbound" | "getOutbound" | "listInbound" | "listOutbound" | "getStats" | "cleanup"
> {
  const { pool, query, transaction, inbound, outbound, saveInbound, saveOutbound } = context;
  return {
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
      params.push(boundedLimit(f.limit));
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
      params.push(boundedLimit(f.limit));
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
          [input.before, boundedLimit(input.limit)],
        );
        for (const { inbound_record: r, outbound_record: o } of rows) {
          await saveInbound(
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
            await saveOutbound(
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
}
