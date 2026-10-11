import { downloadMedia, mediaBlob, mediaKind } from "@relanox/media";
import type { ChannelHost, MediaUpload, SendInput, SendResult } from "@relanox/sdk";
import { z } from "zod";
import type { MattermostConfig } from "./config.js";
import { httpFailure, readJson } from "./protocol.js";

const infoSchema = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
});
export async function receiveFiles(
  ids: readonly string[],
  host: ChannelHost,
  config: MattermostConfig,
  base: string,
  authorization: string,
  signal: AbortSignal,
): Promise<MediaUpload[]> {
  const attachments: MediaUpload[] = [];
  const bound = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  for (const id of ids) {
    const url = `${base}/api/v4/files/${encodeURIComponent(id)}`;
    const response = await fetch(`${url}/info`, {
      headers: { Authorization: authorization },
      redirect: "error",
      signal: bound,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("media_metadata_failed");
    }
    const info = infoSchema.parse(await readJson(response));
    if (info.id !== id || info.size > (host.maxMediaBytes ?? 16_777_216)) {
      throw new Error("invalid_media_metadata");
    }
    const downloaded = await downloadMedia(url, {
      maxBytes: host.maxMediaBytes ?? 16_777_216,
      signal: bound,
      headers: { Authorization: authorization },
      trustedOrigins: [new URL(base).origin],
      allowInsecureLocalhost: config.allowInsecureLocalhost,
    });
    attachments.push({
      kind: mediaKind(info.mime_type),
      mimeType: info.mime_type,
      fileName: info.name,
      data: downloaded.data,
    });
  }
  return attachments;
}
export async function uploadFile(
  input: SendInput,
  base: string,
  authorization: string,
  signal: AbortSignal,
): Promise<{ fileId: string } | SendResult> {
  if (!input.media) {
    throw new Error("media_missing");
  }
  const form = new FormData();
  form.set("channel_id", input.target.chatId);
  form.set("files", mediaBlob(input.media), input.media.reference.fileName);
  const response = await fetch(`${base}/api/v4/files`, {
    method: "POST",
    body: form,
    headers: { Authorization: authorization },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return httpFailure(response);
  }
  const uploaded = z
    .object({ file_infos: z.array(z.object({ id: z.string().min(1).max(1024) })).length(1) })
    .parse(await readJson(response));
  const file = uploaded.file_infos[0];
  if (!file) {
    throw new Error("media_upload_failed");
  }
  return { fileId: file.id };
}
