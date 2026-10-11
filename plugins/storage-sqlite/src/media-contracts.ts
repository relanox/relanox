import { createHash } from "node:crypto";
import type { MediaReference, StoredMedia, InboundSnapshot, MediaStorage } from "@relanox/sdk";
import { equalDurableValues } from "./record-codec.js";

export function validMedia(media: StoredMedia): boolean {
  const ref = media.reference;
  return (
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    ["image", "audio", "video", "file"].includes(ref.kind) &&
    typeof ref.mimeType === "string" &&
    typeof ref.fileName === "string" &&
    (ref.durationMs === undefined ||
      (Number.isSafeInteger(ref.durationMs) && ref.durationMs > 0)) &&
    (ref.previewMediaId === undefined ||
      (typeof ref.previewMediaId === "string" && ref.previewMediaId.length > 0)) &&
    media.data instanceof Uint8Array &&
    ref.size === media.data.byteLength &&
    ref.sha256 === createHash("sha256").update(media.data).digest("hex")
  );
}

export function validateIncoming(snapshot: InboundSnapshot, media: readonly StoredMedia[]): void {
  const refs = snapshot.attachments ?? [];
  if (
    refs.length !== media.length ||
    new Set(refs.map((ref) => ref.id)).size !== refs.length ||
    !media.every(
      (asset, index) => validMedia(asset) && equalDurableValues(asset.reference, refs[index]),
    )
  ) {
    throw new TypeError("Inbound media does not match snapshot");
  }
}

export const sameReference = (left: MediaReference, right: MediaReference): boolean =>
  equalDurableValues(left, right);

export function withinMediaBudget(
  input: Parameters<MediaStorage["put"]>[0],
  count: number,
  bytes: number,
): boolean {
  const maxCount = input.maxCount ?? 20;
  const maxTotalBytes = input.maxTotalBytes ?? 200 * 1024 * 1024;
  return (
    Number.isSafeInteger(maxCount) &&
    maxCount >= 0 &&
    Number.isSafeInteger(maxTotalBytes) &&
    maxTotalBytes >= 0 &&
    count < maxCount &&
    bytes + input.media.data.byteLength <= maxTotalBytes
  );
}
