import { createHash } from "node:crypto";
import { mediaBlob } from "@relanox/media";
import type { ChannelHost, SendInput } from "@relanox/sdk";
import type { DiscordConfig } from "./config.js";
import { postJson } from "./transport.js";

export function mediaError(input: SendInput, host: ChannelHost): string | undefined {
  if (
    input.chunk.media &&
    (!input.media ||
      input.media.data.byteLength >
        Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, 10 * 1024 * 1024))
  ) {
    return "media_limit_exceeded";
  }
  return undefined;
}

export async function sendMessage(
  input: SendInput,
  host: ChannelHost,
  config: DiscordConfig,
  token: string,
): Promise<Response> {
  const payload = {
    content: input.chunk.text,
    allowed_mentions: { parse: [], replied_user: false },
    nonce: createHash("sha256").update(input.chunk.idempotencyKey).digest("hex").slice(0, 24),
    enforce_nonce: true,
    ...(input.target.replyToId
      ? { message_reference: { message_id: input.target.replyToId, fail_if_not_exists: false } }
      : {}),
  };
  const url = `${config.apiBaseUrl.replace(/\/$/u, "")}/channels/${input.target.threadId ?? input.target.chatId}/messages`;
  const headers = { authorization: `Bot ${token}` };
  if (!input.chunk.media) {
    return postJson(url, headers, payload, input.signal, config.timeoutMs);
  }
  const media = input.media;
  if (
    !media ||
    media.data.byteLength > Math.min(host.maxMediaBytes ?? 25 * 1024 * 1024, 10 * 1024 * 1024)
  ) {
    throw new Error("media_limit_exceeded");
  }
  const body = new FormData();
  body.set(
    "payload_json",
    JSON.stringify({ ...payload, attachments: [{ id: 0, filename: media.reference.fileName }] }),
  );
  body.set("files[0]", mediaBlob(media), media.reference.fileName);
  return fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)]),
    redirect: "error",
  });
}
