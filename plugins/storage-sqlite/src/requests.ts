import type { Storage, InboundRecord } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { encode, decode, resultDigest } from "./record-codec.js";
import { matchesInitialResult, isRequestInScope } from "./record-contracts.js";

export function createRequestOperations(
  context: DatabaseContext,
): Pick<Storage, "acceptInbound" | "listPending" | "claimRequest" | "completeAndEnqueue" | "fail"> {
  const { db, transaction, inbound, saveInbound, isEndpointHead } = context;
  return {
    async acceptInbound(snapshot) {
      return transaction(() => {
        const row = db
          .prepare("SELECT id FROM inbound WHERE channel=? AND account=? AND event=?")
          .get(snapshot.source.channel, snapshot.source.accountId, snapshot.source.eventId) as
          | { id: string }
          | undefined;
        if (row) {
          return { requestId: row.id, duplicate: true };
        }
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
      if (input.endpointIds.length === 0) {
        return [];
      }
      const placeholders = input.endpointIds.map(() => "?").join(",");
      return (
        db
          .prepare(
            `SELECT record FROM inbound WHERE status='pending' AND endpoint IN (${placeholders}) AND json_extract(record,'$.snapshot.endpoint.agent')=? ORDER BY accepted_at,id LIMIT ?`,
          )
          .all(...input.endpointIds, input.agent, input.limit) as { record: string }[]
      ).map((x) => decode<InboundRecord>(x.record).snapshot);
    },
    async claimRequest(input) {
      return transaction(() => {
        const r = inbound(input.requestId);
        if (!r || !isRequestInScope(r, input)) {
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
        if (!isEndpointHead(r)) {
          return { status: "busy" };
        }
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        saveInbound({
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
        if (!r) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(r, input) || r.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (r.status === "completed") {
          const row = db
            .prepare("SELECT final_digest FROM inbound WHERE id=?")
            .get(input.requestId) as { final_digest: string };
          const o = db
            .prepare("SELECT id FROM outbound WHERE request_id=?")
            .get(input.requestId) as { id: string };
          return r.result?.resultId === input.result.resultId &&
            row.final_digest === resultDigest(input.result.text)
            ? { status: "completed", deliveryId: o.id, replay: true }
            : { status: "conflict" };
        }
        if (r.status !== "claimed") {
          return { status: "conflict" };
        }
        const o = input.outbound;
        if (!matchesInitialResult(o, r, input)) {
          return { status: "conflict" };
        }
        if (
          db.prepare("SELECT id FROM inbound WHERE final_id=?").get(input.result.resultId) !==
            undefined ||
          db.prepare("SELECT id FROM outbound WHERE id=?").get(o.deliveryId) !== undefined
        ) {
          return { status: "conflict" };
        }
        const dispatch = { ...r.dispatch };
        delete dispatch.lease;
        db.prepare(
          "INSERT INTO outbound(id,request_id,result_id,status,version,record) VALUES(?,?,?,?,?,?)",
        ).run(o.deliveryId, o.requestId, o.resultId, o.status, 1, encode(o));
        saveInbound({
          ...r,
          status: "completed",
          version: r.version + 1,
          result: input.result,
          dispatch,
        });
        db.prepare("UPDATE inbound SET final_id=?,final_digest=? WHERE id=?").run(
          input.result.resultId,
          resultDigest(input.result.text),
          input.requestId,
        );
        return { status: "completed", deliveryId: o.deliveryId, replay: false };
      });
    },
    async fail(input) {
      return transaction(() => {
        const r = inbound(input.requestId);
        if (!r) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(r, input) || r.claim?.token !== input.claimToken) {
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
        saveInbound({
          ...r,
          status: "failed",
          version: r.version + 1,
          errorCode: input.errorCode,
          dispatch,
        });
        return { status: "updated", version: r.version + 1 };
      });
    },
  };
}
