import type { Storage, InboundRecord, OutboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { boundedLimit } from "./database.js";

export function createInspectionOperations(
  context: Pick<
    DatabaseContext,
    | "pool"
    | "query"
    | "transaction"
    | "readInbound"
    | "readOutbound"
    | "saveInbound"
    | "saveOutbound"
  >,
): Pick<
  Storage,
  "getInbound" | "getOutbound" | "listInbound" | "listOutbound" | "getStats" | "cleanup"
> {
  const { pool, query, transaction, readInbound, readOutbound, saveInbound, saveOutbound } =
    context;
  return {
    async getInbound(id) {
      return readInbound(pool, id);
    },
    async getOutbound(id) {
      return readOutbound(pool, id);
    },
    async listInbound(filter) {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (filter.requestStatus !== undefined) {
        params.push(filter.requestStatus);
        where.push(`status=$${params.length}`);
      }
      if (filter.endpointId !== undefined) {
        params.push(filter.endpointId);
        where.push(`endpoint=$${params.length}`);
      }
      if (filter.afterId !== undefined) {
        params.push(filter.afterId);
        where.push(`id>$${params.length}`);
      }
      params.push(boundedLimit(filter.limit));
      return (
        await query<{ record: InboundRecord }>(
          pool,
          `
            SELECT record
            FROM inbound
            WHERE ${where.join(" AND ")}
            ORDER BY id
            LIMIT $${params.length}
          `,
          params,
        )
      ).map((record) => record.record);
    },
    async listOutbound(filter) {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (filter.deliveryStatus !== undefined) {
        params.push(filter.deliveryStatus);
        where.push(`outbound_delivery.status=$${params.length}`);
      }
      if (filter.endpointId !== undefined) {
        params.push(filter.endpointId);
        where.push(`inbound_request.endpoint=$${params.length}`);
      }
      if (filter.afterId !== undefined) {
        params.push(filter.afterId);
        where.push(`outbound_delivery.id>$${params.length}`);
      }
      params.push(boundedLimit(filter.limit));
      return (
        await query<{ record: OutboundRecord }>(
          pool,
          `
            SELECT outbound_delivery.record
            FROM outbound outbound_delivery
            JOIN inbound inbound_request ON inbound_request.id=outbound_delivery.request_id
            WHERE ${where.join(" AND ")}
            ORDER BY outbound_delivery.id
            LIMIT $${params.length}
          `,
          params,
        )
      ).map((record) => record.record);
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
            SELECT
              COUNT(*) FILTER(WHERE status='pending') pending,
              COUNT(*) FILTER(WHERE status='claimed') claimed,
              MIN(accepted_at) FILTER(WHERE status='pending') oldest,
              (SELECT COUNT(*) FROM outbound WHERE status!='sent') undelivered,
              COUNT(*) FILTER(
                WHERE status='pending' AND record#>>'{dispatch,status}'='unknown'
              ) + (SELECT COUNT(*) FROM outbound WHERE status='unknown') unknown
            FROM inbound
          `,
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
            SELECT inbound_request.record inbound_record,outbound_delivery.record outbound_record
            FROM inbound inbound_request
            LEFT JOIN outbound outbound_delivery ON outbound_delivery.request_id=inbound_request.id
            WHERE inbound_request.accepted_at<$1
              AND inbound_request.record->'redactedAt' IS NULL
              AND (inbound_request.status='failed'
                OR (inbound_request.status='completed'
                  AND outbound_delivery.status='sent'))
            ORDER BY inbound_request.accepted_at,inbound_request.id
            LIMIT $2
          `,
          [input.before, boundedLimit(input.limit)],
        );
        for (const { inbound_record: record, outbound_record: delivery } of rows) {
          await saveInbound(
            client,
            {
              ...record,
              snapshot: { ...record.snapshot, text: "", context: null },
              ...(record.result ? { result: { ...record.result, text: "" } } : {}),
              redactedAt: input.before,
            },
            record.version,
          );
          if (delivery) {
            await saveOutbound(
              client,
              {
                ...delivery,
                chunks: delivery.chunks.map((chunk) => ({ ...chunk, text: "", state: null })),
                receipts: delivery.receipts.map(() => ({})),
              },
              delivery.version,
            );
          }
        }
        return { redacted: rows.length };
      });
    },
  };
}
