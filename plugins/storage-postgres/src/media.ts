import type { MediaStorage, StoredMedia, MediaReference } from "@relanox/sdk";
import type { DatabaseContext } from "./database.js";
import { createHash } from "node:crypto";
import { encodeDurableRecord } from "./record-codec.js";
import { validMedia, withinMediaBudget } from "./media-contracts.js";
import { isRequestInScope } from "./record-contracts.js";
import type { Pool, PoolClient } from "pg";

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
        ...(media.reference.durationMs === undefined && media.reference.previewMediaId === undefined
          ? []
          : [media.reference.durationMs ?? null, media.reference.previewMediaId ?? null]),
      ]),
    )
    .digest("hex");
export async function readMedia(
  context: DatabaseContext,
  client: Pool | PoolClient,
  requestId: string,
  mediaId: string,
): Promise<StoredMedia | undefined> {
  const row = (
    await context.query<{ reference: MediaReference; data: Buffer }>(
      client,
      "SELECT reference,data FROM media WHERE request_id=$1 AND id=$2 AND data IS NOT NULL",
      [requestId, mediaId],
    )
  )[0];
  return row ? { reference: row.reference, data: new Uint8Array(row.data) } : undefined;
}
export async function insertIncomingMedia(
  context: DatabaseContext,
  client: PoolClient,
  requestId: string,
  assets: readonly StoredMedia[],
): Promise<void> {
  for (const asset of assets) {
    await client.query(
      "INSERT INTO media(id,request_id,reference,data,digest) VALUES($1,$2,$3::jsonb,$4,$5)",
      [
        asset.reference.id,
        requestId,
        encodeDurableRecord(asset.reference),
        Buffer.from(asset.data),
        digest(asset),
      ],
    );
  }
}
export function createMediaOperations(context: DatabaseContext): MediaStorage {
  return {
    async get(requestId, mediaId) {
      return readMedia(context, context.pool, requestId, mediaId);
    },
    async put(input) {
      return context.transaction(async (client) => {
        const record = await context.readInbound(client, input.requestId);
        if (!record) {
          return { status: "not_found" };
        }
        if (!isRequestInScope(record, input) || record.claim?.token !== input.claimToken) {
          return { status: "unauthorized" };
        }
        if (record.status !== "claimed" || !validMedia(input.media)) {
          return { status: "conflict" };
        }
        const existing = (
          await context.query<{ request_id: string; digest: string }>(
            client,
            "SELECT request_id,digest FROM media WHERE id=$1",
            [input.media.reference.id],
          )
        )[0];
        if (existing) {
          return existing.request_id === input.requestId && existing.digest === digest(input.media)
            ? { status: "stored", media: input.media.reference, replay: true }
            : { status: "conflict" };
        }
        const usage = (
          await context.query<{ count: string; bytes: string }>(
            client,
            "SELECT COUNT(*) count,COALESCE(SUM(octet_length(data)),0) bytes FROM media WHERE request_id=$1 AND data IS NOT NULL",
            [input.requestId],
          )
        )[0];
        if (!usage || !withinMediaBudget(input, Number(usage.count), Number(usage.bytes))) {
          return { status: "conflict" };
        }
        const inserted = await context.query(
          client,
          "INSERT INTO media(id,request_id,reference,data,digest) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
          [
            input.media.reference.id,
            input.requestId,
            encodeDurableRecord(input.media.reference),
            Buffer.from(input.media.data),
            digest(input.media),
          ],
        );
        if (inserted.length === 0) {
          return { status: "conflict" };
        }
        return { status: "stored", media: input.media.reference, replay: false };
      });
    },
  };
}
