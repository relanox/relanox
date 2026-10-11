import type { MediaKind, StoredMedia } from "@relanox/sdk";

export { downloadMedia } from "./download.js";
export type { DownloadMediaOptions, DownloadedMedia } from "./download.js";
export { MediaDownloadError } from "./errors.js";

export function mediaKind(mimeType: string): MediaKind {
  const prefix = mimeType.toLowerCase().split("/")[0];
  return prefix === "image" || prefix === "audio" || prefix === "video" ? prefix : "file";
}

/** Own a binary Blob suitable for native multipart upload without exposing its platform credentials. */
export function mediaBlob(media: StoredMedia): Blob {
  return new Blob([new Uint8Array(media.data)], { type: media.reference.mimeType });
}
