import type { ChannelHost, IngestInput, SecretRef, SendResult } from "@relanox/sdk";
import { z } from "zod";

export function secret(ref: SecretRef): string {
  const value = process.env[ref.env];
  if (!value) {
    throw new Error("missing_credential");
  }
  return value;
}

export async function rawBody(incoming: Request): Promise<Uint8Array> {
  const bytes = new Uint8Array(await incoming.arrayBuffer());
  if (bytes.length > 2_097_152) {
    throw new Error("body_too_large");
  }
  return bytes;
}

export function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export async function ingest(host: ChannelHost, input: IngestInput): Promise<void> {
  try {
    await host.ingest(input);
  } catch (error) {
    const code = z.object({ code: z.string() }).safeParse(error);
    if (!code.success || !["sender_not_allowed", "unbound_conversation"].includes(code.data.code)) {
      throw error;
    }
    host.observe.log("info", "channel_policy_rejection", { errorCode: code.data.code });
  }
}

export async function request(
  url: URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return fetch(url, { ...init, signal: bounded, redirect: "error" });
}

export function failure(response: Response): SendResult {
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
    return { status: "retryable", errorCode: "rate_limited", retryAfterMs: delay };
  }
  const status = response.status >= 400 && response.status < 500 ? "rejected" : "unknown";
  return { status, errorCode: `provider_http_${response.status}` };
}

export function unavailable(): SendResult {
  return { status: "unknown", errorCode: "transport_or_response_unknown" };
}
