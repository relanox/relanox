import { randomUUID } from "node:crypto";
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import type { z } from "zod";
import { validateConfig, validateEndpointUrl } from "./config.js";
import type { LineConfig } from "./config.js";
import { receiveEvent } from "./inbound.js";
import { mediaError, messages } from "./media.js";
import { failure, parseBody, rawBody, request, secret, signed, unavailable } from "./io.js";
import { webhookSchema, targetSchema, retrySchema, receiptSchema } from "./schemas.js";

async function retryIdentity(host: ChannelHost, key: string): Promise<z.infer<typeof retrySchema>> {
  const stateKey = `push:${key}`;
  const previous = await host.state.get(stateKey);
  if (previous) {
    return retrySchema.parse(previous.value);
  }
  const value = { retryKey: randomUUID(), startedAt: Date.now() };
  const result = await host.state.compareAndSet({ key: stateKey, expectedVersion: null, value });
  if (result.status === "updated") {
    return value;
  }
  const winner = await host.state.get(stateKey);
  if (!winner) {
    throw new Error("retry_identity_conflict");
  }
  return retrySchema.parse(winner.value);
}

export function createLineChannel(): ChannelPlugin<LineConfig> {
  let runtime: { host: ChannelHost; account: AccountConfig; config: LineConfig } | undefined;
  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== "line"
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const { host, config } = runtime;
    const parsed = targetSchema.safeParse(input.target.data);
    if (
      !parsed.success ||
      parsed.data.destination !== input.target.chatId ||
      parsed.data.botId !== config.botUserId ||
      parsed.data.apiBaseUrl !== new URL(config.apiBase).toString().replace(/\/$/u, "")
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const target = parsed.data;
    const errorCode = mediaError(input, host);
    if (errorCode) {
      return { status: "rejected", errorCode };
    }
    const retry = await retryIdentity(host, input.chunk.idempotencyKey);
    if (Date.now() - retry.startedAt >= 86_400_000) {
      return { status: "unknown", errorCode: "retry_key_expired" };
    }
    const outgoing = await messages(input, host).catch(() => ({
      status: "retryable" as const,
      errorCode: "media_publication_failed",
    }));
    if (!Array.isArray(outgoing)) {
      return outgoing;
    }
    try {
      const response = await request(
        validateEndpointUrl(`${config.apiBase}/v2/bot/message/push`, config.allowLoopback),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret(config.accessToken)}`,
            "content-type": "application/json",
            "x-line-retry-key": retry.retryKey,
          },
          body: JSON.stringify({
            to: target.destination,
            messages: outgoing,
          }),
        },
        input.signal,
      );
      const acceptedId = response.headers.get("x-line-accepted-request-id");
      if (response.status === 409 && acceptedId) {
        return { status: "sent", receipt: { data: { acceptedRequestId: acceptedId } } };
      }
      if (!response.ok) {
        return failure(response);
      }
      const receipt = receiptSchema.parse(await response.json());
      const first = receipt.sentMessages?.[0];
      return { status: "sent", receipt: first ? { platformMessageId: first.id } : {} };
    } catch {
      return unavailable();
    }
  }
  return {
    id: "channel-line",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "line",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 5000,
      lengthUnit: "utf16",
      idempotentSend: false,
      media: { receive: ["image", "audio", "video", "file"], send: ["image", "audio", "video"] },
    },
    validateConfig,
    async setup(host, account, config) {
      runtime = { host, account, config };
      host.mountHttp("/webhook", async (incoming) => {
        if (incoming.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const body = await rawBody(incoming);
        if (
          !signed(
            body,
            incoming.headers.get("x-line-signature"),
            secret(config.channelSecret),
            "base64",
          )
        ) {
          return new Response(null, { status: 401 });
        }
        const decoded = webhookSchema.safeParse(parseBody(body));
        if (!decoded.success) {
          return new Response(null, { status: 400 });
        }
        if (decoded.data.destination !== config.botUserId) {
          return new Response(null, { status: 403 });
        }
        for (const event of decoded.data.events) {
          await receiveEvent(host, account, config, event);
        }
        return Response.json({});
      });
    },
    send,
  };
}
