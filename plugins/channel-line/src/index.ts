import { randomUUID } from "node:crypto";
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { z } from "zod";
import {
  endpoint,
  failure,
  identifier,
  ingest,
  parseBody,
  rawBody,
  request,
  secret,
  secretRef,
  signed,
  unavailable,
} from "./io.js";

const configSchema = z.strictObject({
  botUserId: identifier,
  channelSecret: secretRef,
  accessToken: secretRef,
  apiBase: z.url().default("https://api.line.me"),
  allowLoopback: z.boolean().default(false),
});
export type LineConfig = z.infer<typeof configSchema>;
const eventSchema = z.object({
  type: z.string(),
  webhookEventId: identifier.optional(),
  timestamp: z.number().int().nonnegative().optional(),
  source: z
    .object({
      type: z.enum(["user", "group", "room"]),
      userId: identifier.optional(),
      groupId: identifier.optional(),
      roomId: identifier.optional(),
    })
    .optional(),
  message: z.object({ id: identifier, type: z.string(), text: z.string().optional() }).optional(),
});
const webhookSchema = z.object({ destination: identifier, events: z.array(eventSchema) });
const targetSchema = z.strictObject({
  destination: identifier,
  sourceType: z.enum(["user", "group", "room"]),
  botId: identifier,
  apiBaseUrl: z.string(),
});
const retrySchema = z.strictObject({
  retryKey: z.uuid(),
  startedAt: z.number().int().nonnegative(),
});
const receiptSchema = z.object({ sentMessages: z.array(z.object({ id: identifier })).optional() });

async function receiveEvent(
  host: ChannelHost,
  account: AccountConfig,
  config: LineConfig,
  event: z.infer<typeof eventSchema>,
): Promise<void> {
  const { source, message } = event;
  if (
    event.type !== "message" ||
    !source ||
    message?.type !== "text" ||
    !message.text ||
    source.userId === config.botUserId
  ) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  if (!event.webhookEventId || !source.userId) {
    throw new Error("missing_event_identity");
  }
  let destination = source.userId;
  if (source.type === "group") {
    destination = source.groupId ?? "";
  }
  if (source.type === "room") {
    destination = source.roomId ?? "";
  }
  if (!destination) {
    throw new Error("missing_destination");
  }
  await ingest(host, {
    source: { channel: "line", accountId: account.id, eventId: event.webhookEventId },
    senderId: source.userId,
    text: message.text,
    receivedAt: Date.now(),
    context: null,
    target: {
      channel: "line",
      accountId: account.id,
      chatId: destination,
      replyToId: message.id,
      data: {
        destination,
        sourceType: source.type,
        botId: config.botUserId,
        apiBaseUrl: new URL(config.apiBase).toString().replace(/\/$/u, ""),
      },
    },
  });
}

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
    const retry = await retryIdentity(host, input.chunk.idempotencyKey);
    if (Date.now() - retry.startedAt >= 86_400_000) {
      return { status: "unknown", errorCode: "retry_key_expired" };
    }
    try {
      const response = await request(
        endpoint(`${config.apiBase}/v2/bot/message/push`, config.allowLoopback),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret(config.accessToken)}`,
            "content-type": "application/json",
            "x-line-retry-key": retry.retryKey,
          },
          body: JSON.stringify({
            to: target.destination,
            messages: [{ type: "text", text: input.chunk.text }],
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
    },
    validateConfig(value) {
      const config = configSchema.parse(value);
      const apiBase = endpoint(config.apiBase, config.allowLoopback).toString().replace(/\/$/u, "");
      return { ...config, apiBase };
    },
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
