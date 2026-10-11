import type { ChannelHost, IngestInput, SecretRef, SendResult } from "@relanox/sdk";
import { z } from "zod";

export function credential(ref: SecretRef, environment: NodeJS.ProcessEnv): string {
  const value = environment[ref.env];
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error("missing_or_invalid_credential");
  }
  return value;
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  max = 1_048_576,
): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        return Buffer.concat(chunks);
      }
      total += next.value.byteLength;
      if (total > max) {
        throw new Error("payload_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export async function jsonResponse(response: Response): Promise<unknown> {
  return JSON.parse((await readBounded(response.body)).toString("utf8"));
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    redirect: "error",
  });
}

export function failure(response: Response): SendResult {
  if (response.status === 429) {
    const delay = Number(response.headers.get("retry-after"));
    return {
      status: "retryable",
      errorCode: "rate_limited",
      ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.ceil(delay * 1000) } : {}),
    };
  }
  return {
    status: response.status >= 500 ? "unknown" : "rejected",
    errorCode: "platform_http_error",
  };
}

/** Policy exclusions are terminal; storage and unexpected failures must remain unacknowledged. */
export async function ingest(host: ChannelHost, input: IngestInput): Promise<void> {
  try {
    await host.ingest(input);
  } catch (error) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (
      !parsed.success ||
      !["sender_not_allowed", "unbound_conversation"].includes(parsed.data.code)
    ) {
      throw error;
    }
    host.observe.log("info", "channel_policy_rejection", { errorCode: parsed.data.code });
  }
}
