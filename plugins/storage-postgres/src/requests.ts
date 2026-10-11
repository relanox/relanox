import type { Storage, InboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { boundedLimit } from "./database.js";
import { encode, resultDigest } from "./record-codec.js";
import { matchesInitialResult, isRequestInScope } from "./record-contracts.js";

export function createRequestOperations(
  context: DatabaseContext,
): Pick<Storage, "acceptInbound" | "listPending" | "claimRequest" | "completeAndEnqueue" | "fail"> {
  const { pool, query, transaction, readInbound, saveInbound, isEndpointHead } = context;
  return {
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
        const record: InboundRecord = {
          snapshot,
          status: "pending",
          version: 1,
          dispatch: { status: "due", attempts: 0, dueAt: snapshot.acceptedAt },
        };
        const inserted = await query<{ id: string }>(
          client,
          `
            INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
            ON CONFLICT(channel,account,event) DO NOTHING
            RETURNING id
          `,
          [
            snapshot.requestId,
            snapshot.source.channel,
            snapshot.source.accountId,
            snapshot.source.eventId,
            snapshot.endpoint.id,
            snapshot.acceptedAt,
            record.status,
            1,
            encode(record),
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
          `
            SELECT record
            FROM inbound
            WHERE status='pending'
              AND endpoint=ANY($1::text[])
              AND record#>>'{snapshot,endpoint,agent}'=$3
            ORDER BY accepted_at,id
            LIMIT $2
          `,
          [input.endpointIds, boundedLimit(input.limit), input.agent],
        )
      ).map((record) => record.record.snapshot);
    },
    async claimRequest(input) {
      return transaction(async (client) => {
        const record = await readInbound(client, input.requestId);
        if (!record || !isRequestInScope(record, input)) {
          return { status: "not_found" };
        }
        if (record.status === "claimed") {
          return record.claim?.key === input.claimKey
            ? {
                status: "claimed",
                request: record.snapshot,
                claimToken: record.claim.token,
                replay: true,
              }
            : { status: "busy" };
        }
        if (record.status !== "pending") {
          return { status: "not_pending" };
        }
        if (!(await isEndpointHead(client, record))) {
          return { status: "busy" };
        }
        const dispatch = { ...record.dispatch };
        delete dispatch.lease;
        await saveInbound(client, {
          ...record,
          status: "claimed",
          version: record.version + 1,
          dispatch,
          claim: {
            key: input.claimKey,
            token: input.claimToken,
            claimedAt: input.now,
          },
        });
        return {
          status: "claimed",
          request: record.snapshot,
          claimToken: input.claimToken,
          replay: false,
        };
      });
    },
    async completeAndEnqueue(input) {
      return transaction(async (client) => {
        const record = await readInbound(client, input.requestId);
        if (!record) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(record, input) || record.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (record.status === "completed") {
          const row = (
            await query<{ final_digest: string }>(
              client,
              "SELECT final_digest FROM inbound WHERE id=$1",
              [input.requestId],
            )
          )[0];
          const delivery = (
            await query<{ id: string }>(client, "SELECT id FROM outbound WHERE request_id=$1", [
              input.requestId,
            ])
          )[0];
          return record.result?.resultId === input.result.resultId &&
            row?.final_digest === resultDigest(input.result.text) &&
            delivery
            ? { status: "completed", deliveryId: delivery.id, replay: true }
            : { status: "conflict" };
        }
        if (record.status !== "claimed") {
          return { status: "conflict" };
        }
        const delivery = input.outbound;
        if (!matchesInitialResult(delivery, record, input)) {
          return { status: "conflict" };
        }
        const inserted = await query(
          client,
          `
            INSERT INTO outbound(id,request_id,result_id,status,version,record)
            VALUES($1,$2,$3,$4,$5,$6::jsonb)
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [
            delivery.deliveryId,
            delivery.requestId,
            delivery.resultId,
            delivery.status,
            1,
            encode(delivery),
          ],
        );
        if (inserted.length === 0) {
          return { status: "conflict" };
        }
        const dispatch = { ...record.dispatch };
        delete dispatch.lease;
        await saveInbound(client, {
          ...record,
          status: "completed",
          version: record.version + 1,
          result: input.result,
          dispatch,
        });
        await client.query(
          "UPDATE inbound SET final_id=$1,final_digest=$2 WHERE id=$3 AND version=$4",
          [
            input.result.resultId,
            resultDigest(input.result.text),
            input.requestId,
            record.version + 1,
          ],
        );
        return { status: "completed", deliveryId: delivery.deliveryId, replay: false };
      });
    },
    async fail(input) {
      return transaction(async (client) => {
        const record = await readInbound(client, input.requestId);
        if (!record) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(record, input) || record.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (record.status === "failed" && record.errorCode === input.errorCode) {
          return { status: "updated", version: record.version };
        }
        if (record.status !== "claimed") {
          return { status: "conflict" };
        }
        const dispatch = { ...record.dispatch };
        delete dispatch.lease;
        await saveInbound(client, {
          ...record,
          status: "failed",
          version: record.version + 1,
          errorCode: input.errorCode,
          dispatch,
        });
        return { status: "updated", version: record.version + 1 };
      });
    },
  };
}
