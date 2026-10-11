import { downloadMedia, mediaBlob } from "@relanox/media";
import type { ChannelHost, MediaUpload, SendInput } from "@relanox/sdk";
import { z } from "zod";
import type { MatrixConfig } from "./config.js";
import { readJson } from "./protocol.js";

const mediaSchema = z.object({
  msgtype: z.enum(["m.image", "m.audio", "m.video", "m.file"]),
  body: z.string().min(1).max(255),
  filename: z.string().min(1).max(255).optional(),
  url: z.string(),
  info: z
    .object({ mimetype: z.string().optional(), duration: z.number().int().positive().optional() })
    .optional(),
});
const uploadResponse = z.object({ content_uri: z.string() });
const kinds = {
  "m.image": "image",
  "m.audio": "audio",
  "m.video": "video",
  "m.file": "file",
} as const;

function contentUri(value: string): { server: string; id: string } {
  const match = /^mxc:\/\/(?<server>[^/?#@\s]+)\/(?<id>[A-Za-z0-9_-]+)$/u.exec(value)?.groups;
  if (!match?.server || !match.id) {
    throw new Error("invalid_media_uri");
  }
  return { server: match.server, id: match.id };
}
export async function receiveMedia(
  content: unknown,
  host: ChannelHost,
  config: MatrixConfig,
  base: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<MediaUpload[]> {
  if (content !== null && typeof content === "object" && "file" in content) {
    throw new Error("encrypted_unsupported");
  }
  const parsed = mediaSchema.safeParse(content);
  if (!parsed.success) {
    return [];
  }
  const data = parsed.data;
  const uri = contentUri(data.url);
  const downloaded = await downloadMedia(
    `${base}/_matrix/client/v1/media/download/${encodeURIComponent(uri.server)}/${encodeURIComponent(uri.id)}`,
    {
      maxBytes: host.maxMediaBytes ?? 16_777_216,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      headers,
      trustedOrigins: [new URL(base).origin],
      allowInsecureLocalhost: config.allowInsecureLocalhost,
    },
  );
  return [
    {
      kind: kinds[data.msgtype],
      fileName: data.filename ?? data.body,
      mimeType: data.info?.mimetype ?? downloaded.mimeType,
      data: downloaded.data,
      ...(data.info?.duration === undefined ? {} : { durationMs: data.info.duration }),
    },
  ];
}
async function upload(
  base: string,
  headers: Readonly<Record<string, string>>,
  media: NonNullable<SendInput["media"]>,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL(`${base}/_matrix/media/v3/upload`);
  url.searchParams.set("filename", media.reference.fileName);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { ...headers, "Content-Type": media.reference.mimeType },
    body: mediaBlob(media),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("media_upload_failed");
  }
  const result = uploadResponse.parse(await readJson(response));
  contentUri(result.content_uri);
  return result.content_uri;
}
export async function messageContent(
  input: SendInput,
  base: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) {
  if (!input.media) {
    return { msgtype: "m.text", body: input.chunk.text };
  }
  const media = input.media;
  const url = await upload(base, headers, media, signal);
  const thumbnailUrl = input.preview
    ? await upload(base, headers, input.preview, signal)
    : undefined;
  return {
    msgtype: `m.${media.reference.kind}`,
    body: media.reference.fileName,
    filename: media.reference.fileName,
    url,
    info: {
      mimetype: media.reference.mimeType,
      size: media.reference.size,
      ...(media.reference.durationMs === undefined ? {} : { duration: media.reference.durationMs }),
      ...(thumbnailUrl && input.preview
        ? {
            thumbnail_url: thumbnailUrl,
            thumbnail_info: {
              mimetype: input.preview.reference.mimeType,
              size: input.preview.reference.size,
            },
          }
        : {}),
    },
  };
}
