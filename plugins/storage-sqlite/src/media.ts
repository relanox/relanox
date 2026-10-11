import type { MediaStorage, StoredMedia } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { createHash } from "node:crypto";
import { encodeDurableRecord, decodeDurableRecord } from "./record-codec.js";
import { validMedia, withinMediaBudget } from "./media-contracts.js";
import { isRequestInScope } from "./record-contracts.js";

const digest = (media: StoredMedia): string =>
  createHash("sha256")
    .update(
      encodeDurableRecord([
        media.reference.id,
        media.reference.kind,
        media.reference.mimeType,
        media.reference.fileName,
        media.reference.size,
        media.reference.sha256,
      ]),
    )
    .digest("hex");
export function readMedia(
  context: DatabaseContext,
  requestId: string,
  mediaId: string,
): StoredMedia | undefined {
  const row = context.db
    .prepare("SELECT reference,data FROM media WHERE request_id=? AND id=? AND data IS NOT NULL")
    .get(requestId, mediaId) as { reference: string; data: Buffer } | undefined;
  return row
    ? { reference: decodeDurableRecord(row.reference), data: new Uint8Array(row.data) }
    : undefined;
}
export function insertIncomingMedia(
  context: DatabaseContext,
  requestId: string,
  assets: readonly StoredMedia[],
): void {
  for (const asset of assets) {
    context.db
      .prepare("INSERT INTO media(id,request_id,reference,data,digest) VALUES(?,?,?,?,?)")
      .run(
        asset.reference.id,
        requestId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        digest(asset),
      );
  }
}
export function createMediaOperations(context: DatabaseContext): MediaStorage {
  return {
    async get(requestId, mediaId) {
      return readMedia(context, requestId, mediaId);
    },
    async put(input) {
      return context.transaction(() => {
        const record = context.readInbound(input.requestId);
        if (!record) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(record, input) || record.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (record.status !== "claimed" || !validMedia(input.media)) {
          return { status: "conflict" };
        }
        const existing = context.db
          .prepare("SELECT request_id,digest FROM media WHERE id=?")
          .get(input.media.reference.id) as { request_id: string; digest: string } | undefined;
        if (existing) {
          return existing.request_id === input.requestId && existing.digest === digest(input.media)
            ? { status: "stored", media: input.media.reference, replay: true }
            : { status: "conflict" };
        }
        const usage = context.db
          .prepare(
            "SELECT COUNT(*) count,COALESCE(SUM(length(data)),0) bytes FROM media WHERE request_id=? AND data IS NOT NULL",
          )
          .get(input.requestId) as { count: number; bytes: number };
        if (!withinMediaBudget(input, usage.count, usage.bytes)) {
          return { status: "conflict" };
        }
        insertIncomingMedia(context, input.requestId, [input.media]);
        return { status: "stored", media: input.media.reference, replay: false };
      });
    },
  };
}
