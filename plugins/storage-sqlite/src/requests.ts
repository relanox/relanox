import { validateIncoming, sameReference } from "./media-contracts.js";
import { readMedia, insertIncomingMedia } from "./media.js";
import type { Storage, InboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { encodeDurableRecord, decodeDurableRecord, resultDigest } from "./record-codec.js";
import { matchesInitialResult, isRequestInScope } from "./record-contracts.js";

export function createRequestOperations(
  context: DatabaseContext,
): Pick<Storage, "acceptInbound" | "listPending" | "claimRequest" | "completeAndEnqueue" | "fail"> {
  const { db, transaction, readInbound, saveInbound, isEndpointHead } = context;
  return {
    async acceptInbound(snapshot, media = []) {
      return transaction(() => {
        const row = db
          .prepare("SELECT id FROM inbound WHERE channel=? AND account=? AND event=?")
          .get(snapshot.source.channel, snapshot.source.accountId, snapshot.source.eventId) as
          | { id: string }
          | undefined;
        if (row) {
          return { requestId: row.id, duplicate: true };
        }
        validateIncoming(snapshot, media);
        const record: InboundRecord = {
          snapshot: decodeDurableRecord(encodeDurableRecord(snapshot)),
          status: "pending",
          version: 1,
          dispatch: { status: "due", attempts: 0, dueAt: snapshot.acceptedAt },
        };
        db.prepare(
          `
            INSERT INTO inbound(id,channel,account,event,endpoint,accepted_at,status,version,record)
            VALUES(?,?,?,?,?,?,?,?,?)
          `,
        ).run(
          snapshot.requestId,
          snapshot.source.channel,
          snapshot.source.accountId,
          snapshot.source.eventId,
          snapshot.endpoint.id,
          snapshot.acceptedAt,
          record.status,
          1,
          encodeDurableRecord(record),
        );
        insertIncomingMedia(context, snapshot.requestId, media);
        return { requestId: snapshot.requestId, duplicate: false };
      });
    },
    async listPending(input) {
      if (input.endpointIds.length === 0) {
        return [];
      }
      const placeholders = input.endpointIds.map(() => "?").join(",");
      return (
        db
          .prepare(
            `
              SELECT record
              FROM inbound
              WHERE status='pending'
                AND endpoint IN (${placeholders})
                AND json_extract(record,'$.snapshot.endpoint.agent')=?
              ORDER BY accepted_at,id
              LIMIT ?
            `,
          )
          .all(...input.endpointIds, input.agent, input.limit) as { record: string }[]
      ).map((row) => decodeDurableRecord<InboundRecord>(row.record).snapshot);
    },
    async claimRequest(input) {
      return transaction(() => {
        const record = readInbound(input.requestId);
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
        if (!isEndpointHead(record)) {
          return { status: "busy" };
        }
        const dispatch = { ...record.dispatch };
        delete dispatch.lease;
        saveInbound({
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
      return transaction(() => {
        const record = readInbound(input.requestId);
        if (!record) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(record, input) || record.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (record.status === "completed") {
          const row = db
            .prepare("SELECT final_digest FROM inbound WHERE id=?")
            .get(input.requestId) as { final_digest: string };
          const delivery = db
            .prepare("SELECT id FROM outbound WHERE request_id=?")
            .get(input.requestId) as { id: string };
          return record.result?.resultId === input.result.resultId &&
            row.final_digest === resultDigest(input.result)
            ? { status: "completed", deliveryId: delivery.id, replay: true }
            : { status: "conflict" };
        }
        if (record.status !== "claimed") {
          return { status: "conflict" };
        }
        for (const reference of input.result.attachments ?? []) {
          const asset = readMedia(context, input.requestId, reference.id);
          if (!asset || !sameReference(asset.reference, reference)) {
            return { status: "conflict" };
          }
        }
        const delivery = input.outbound;
        if (!matchesInitialResult(delivery, record, input)) {
          return { status: "conflict" };
        }
        if (
          db.prepare("SELECT id FROM inbound WHERE final_id=?").get(input.result.resultId) !==
            undefined ||
          db.prepare("SELECT id FROM outbound WHERE id=?").get(delivery.deliveryId) !== undefined
        ) {
          return { status: "conflict" };
        }
        const dispatch = { ...record.dispatch };
        delete dispatch.lease;
        db.prepare(
          "INSERT INTO outbound(id,request_id,result_id,status,version,record) VALUES(?,?,?,?,?,?)",
        ).run(
          delivery.deliveryId,
          delivery.requestId,
          delivery.resultId,
          delivery.status,
          1,
          encodeDurableRecord(delivery),
        );
        saveInbound({
          ...record,
          status: "completed",
          version: record.version + 1,
          result: input.result,
          dispatch,
        });
        db.prepare("UPDATE inbound SET final_id=?,final_digest=? WHERE id=?").run(
          input.result.resultId,
          resultDigest(input.result),
          input.requestId,
        );
        return { status: "completed", deliveryId: delivery.deliveryId, replay: false };
      });
    },
    async fail(input) {
      return transaction(() => {
        const record = readInbound(input.requestId);
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
        saveInbound({
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
