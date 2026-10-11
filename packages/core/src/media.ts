import { createHash } from "node:crypto";
import type { MediaUpload, StoredMedia, MediaReference } from "@relanox/sdk";
import { z } from "zod";
import { CoreError } from "./errors.js";

const uploadSchema = z.strictObject({
  kind: z.enum(["image", "audio", "video", "file"]),
  mimeType: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) => name.isWellFormed() && !/[\p{Cc}/\\]/u.test(name) && name !== "." && name !== "..",
    ),
  data: z.instanceof(Uint8Array),
});
export const mediaId = z.uuid();
export function storeUpload(upload: MediaUpload, id: string, maximum: number): StoredMedia {
  const valid = uploadSchema.parse(upload);
  if (valid.data.byteLength < 1 || valid.data.byteLength > maximum) {
    throw new CoreError("media_too_large");
  }
  if (valid.kind !== "file" && !valid.mimeType.toLowerCase().startsWith(`${valid.kind}/`)) {
    throw new CoreError("invalid_media_type");
  }
  const data = new Uint8Array(valid.data);
  return {
    reference: {
      id: mediaId.parse(id),
      kind: valid.kind,
      mimeType: valid.mimeType.toLowerCase(),
      fileName: valid.fileName,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
    data,
  };
}
export function validateMediaCount(count: number, maximum: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new CoreError("too_many_attachments");
  }
}
export function verifiedMedia(
  media: StoredMedia,
  reference: MediaReference,
  maximum: number,
): StoredMedia {
  const checked = storeUpload(
    {
      data: media.data,
      kind: media.reference.kind,
      mimeType: media.reference.mimeType,
      fileName: media.reference.fileName,
    },
    media.reference.id,
    maximum,
  );
  if (
    checked.reference.id !== reference.id ||
    checked.reference.kind !== reference.kind ||
    checked.reference.mimeType !== reference.mimeType ||
    checked.reference.fileName !== reference.fileName ||
    checked.reference.size !== reference.size ||
    checked.reference.sha256 !== reference.sha256
  ) {
    throw new CoreError("media_integrity_error");
  }
  return checked;
}

export function inboundMedia(
  uploads: readonly MediaUpload[] | undefined,
  maximum: number,
  count: number,
  supported: boolean,
  totalMaximum: number,
): readonly StoredMedia[] {
  validateMediaCount(uploads?.length ?? 0, count);
  const media = (uploads ?? []).map((upload) => storeUpload(upload, crypto.randomUUID(), maximum));
  validateMediaTotal(media, totalMaximum);
  if (media.length > 0 && !supported) {
    throw new CoreError("media_storage_missing");
  }
  return media;
}

export function validateMediaTotal(media: readonly StoredMedia[], maximum: number): void {
  if (media.reduce((total, item) => total + item.data.byteLength, 0) > maximum) {
    throw new CoreError("media_total_too_large");
  }
}
