import { createDecipheriv, createHash } from "node:crypto";
import type { AccountConfig, ChannelHost, ChannelPlugin, SendResult } from "@relanox/sdk";
import { z } from "zod";
import {
  address,
  bytes,
  credential,
  equal,
  failure,
  fresh,
  id,
  ingest,
  jsonResponse,
  post,
  secret,
  transportOptions,
} from "./transport.js";

const configSchema = z.strictObject({
  appId: id,
  appSecret: secret,
  verificationToken: secret,
  encryptKey: secret,
  tenantKey: id,
  botOpenId: id,
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  apiBaseUrl: z.string().optional(),
  ...transportOptions,
});
export type FeishuConfig = z.infer<typeof configSchema>;
const headerSchema = z.looseObject({
  event_id: id,
  event_type: id,
  app_id: id,
  tenant_key: id,
  token: id,
});
const eventSchema = z.looseObject({
  schema: z.literal("2.0"),
  header: headerSchema,
  event: z.unknown(),
});
const messageSchema = z.looseObject({
  sender: z.looseObject({
    sender_type: id,
    sender_id: z.looseObject({ open_id: id.optional() }),
    tenant_key: id.optional(),
  }),
  message: z.looseObject({
    message_id: id,
    chat_id: id,
    chat_type: id,
    message_type: id,
    content: z.string().max(1_048_576),
    create_time: z.string(),
    root_id: id.optional(),
    parent_id: id.optional(),
    thread_id: id.optional(),
  }),
});
const apiSchema = z.looseObject({
  code: z.number().int(),
  data: z.looseObject({ message_id: id.optional() }).optional(),
});

export function createFeishuChannel(
  environment: NodeJS.ProcessEnv = process.env,
): ChannelPlugin<FeishuConfig> {
  let host: ChannelHost;
  let account: AccountConfig;
  let config: FeishuConfig;
  let token: { value: string; until: number; secretDigest: string } | undefined;
  const base = () =>
    config.apiBaseUrl ??
    (config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn");
  async function accessToken(signal: AbortSignal): Promise<string | SendResult> {
    const appSecret = credential(config.appSecret, environment);
    const secretDigest = createHash("sha256").update(appSecret).digest("hex");
    if (token && token.until > Date.now() && token.secretDigest === secretDigest) {
      return token.value;
    }
    const response = await post(
      `${base().replace(/\/$/u, "")}/open-apis/auth/v3/tenant_access_token/internal`,
      {},
      { app_id: config.appId, app_secret: appSecret },
      signal,
      config.timeoutMs,
    );
    if (!response.ok) {
      return response.status >= 500
        ? { status: "retryable", errorCode: "tenant_token_unavailable" }
        : failure(response);
    }
    const parsed = z
      .looseObject({
        code: z.number().int(),
        tenant_access_token: id.optional(),
        expire: z.number().positive().optional(),
      })
      .safeParse(await jsonResponse(response));
    if (!parsed.success) {
      return { status: "retryable", errorCode: "tenant_token_unavailable" };
    }
    if (parsed.data.code !== 0) {
      return { status: "rejected", errorCode: "tenant_token_unavailable" };
    }
    if (!parsed.data.tenant_access_token || !parsed.data.expire) {
      return { status: "retryable", errorCode: "tenant_token_unavailable" };
    }
    token = {
      value: parsed.data.tenant_access_token,
      until: Date.now() + Math.max(0, parsed.data.expire * 1000 - 60_000),
      secretDigest,
    };
    return token.value;
  }
  async function verifyRequest(request: Request): Promise<unknown> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    const timestamp = request.headers.get("x-lark-request-timestamp");
    const nonce = request.headers.get("x-lark-request-nonce");
    if (!fresh(timestamp) || !nonce || nonce.length > 256) {
      return new Response(null, { status: 401 });
    }
    let raw: Buffer;
    try {
      raw = await bytes(request);
    } catch {
      return new Response(null, { status: 413 });
    }
    const encryptKey = credential(config.encryptKey, environment);
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${encryptKey}`)
      .update(raw)
      .digest("hex");
    if (!equal(signature, request.headers.get("x-lark-signature") ?? "")) {
      return new Response(null, { status: 401 });
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8"));
      const encrypted = z.object({ encrypt: z.string().min(1).max(1_048_576) }).safeParse(value);
      if (encrypted.success) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encrypted.data.encrypt)) {
          throw new Error("invalid_encryption");
        }
        const payload = Buffer.from(encrypted.data.encrypt, "base64");
        if (payload.length < 32 || payload.length % 16) {
          throw new Error("invalid_encryption");
        }
        const decipher = createDecipheriv(
          "aes-256-cbc",
          createHash("sha256").update(encryptKey).digest(),
          payload.subarray(0, 16),
        );
        value = JSON.parse(
          Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8"),
        );
      }
    } catch {
      return new Response(null, { status: 400 });
    }

    return value;
  }

  async function receiveEvent(event: z.infer<typeof eventSchema>): Promise<Response> {
    const { header } = event;
    if (
      !equal(header.token, credential(config.verificationToken, environment)) ||
      header.app_id !== config.appId ||
      header.tenant_key !== config.tenantKey
    ) {
      return new Response(null, { status: 401 });
    }
    if (header.event_type !== "im.message.receive_v1") {
      host.observe.count("relanox_inbound_total", {
        channel: "feishu",
        operation: "ingest",
        outcome: "rejected",
        error_class: "unsupported",
      });
      return new Response(null, { status: 204 });
    }
    const messageEvent = messageSchema.safeParse(event.event);
    if (!messageEvent.success) {
      return new Response(null, { status: 400 });
    }
    const { message, sender } = messageEvent.data;
    if (
      sender.sender_type !== "user" ||
      sender.sender_id.open_id === config.botOpenId ||
      message.message_type !== "text" ||
      !sender.sender_id.open_id
    ) {
      host.observe.count("relanox_inbound_total", {
        channel: "feishu",
        operation: "ingest",
        outcome: "rejected",
        error_class: "unsupported",
      });
      return new Response(null, { status: 204 });
    }
    if (sender.tenant_key && sender.tenant_key !== config.tenantKey) {
      return new Response(null, { status: 401 });
    }
    let text: string;
    try {
      text = z
        .looseObject({ text: z.string().min(1).max(1_048_576) })
        .parse(JSON.parse(message.content)).text;
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      const threadId = message.thread_id ?? message.root_id;
      await ingest(host, {
        source: {
          channel: "feishu",
          accountId: account.id,
          eventId: header.event_id,
        },
        senderId: sender.sender_id.open_id,
        text,
        target: {
          channel: "feishu",
          accountId: account.id,
          chatId: message.chat_id,
          ...(threadId ? { threadId } : {}),
          replyToId: message.message_id,
          data: { tenantKey: config.tenantKey },
        },
        context: {
          tenantKey: config.tenantKey,
          ...(message.parent_id ? { parentId: message.parent_id } : {}),
        },
        receivedAt: Date.now(),
      });
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  return {
    id: "channel-feishu",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "feishu",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 10_000,
      lengthUnit: "utf8",
      idempotentSend: false,
    },
    validateConfig(input) {
      const parsed = configSchema.parse(input);
      if (parsed.apiBaseUrl) {
        address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
      }
      return parsed;
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost;
      account = nextAccount;
      config = nextConfig;
      credential(config.appSecret, environment);
      credential(config.encryptKey, environment);
      credential(config.verificationToken, environment);
      host.mountHttp("/events", async (request) => {
        const value = await verifyRequest(request);
        if (value instanceof Response) {
          return value;
        }
        const challenge = z
          .looseObject({
            type: z.literal("url_verification"),
            token: id,
            challenge: id,
          })
          .safeParse(value);
        if (challenge.success) {
          if (!equal(challenge.data.token, credential(config.verificationToken, environment))) {
            return new Response(null, { status: 401 });
          }
          return Response.json({ challenge: challenge.data.challenge });
        }
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) {
          return new Response(null, { status: 400 });
        }
        return receiveEvent(parsed.data);
      });
    },
    async send(input) {
      const data = z.object({ tenantKey: id }).safeParse(input.target.data);
      if (
        input.target.channel !== "feishu" ||
        input.target.accountId !== account.id ||
        !/^[A-Za-z0-9_-]+$/u.test(input.target.chatId) ||
        (input.target.replyToId && !/^[A-Za-z0-9_-]+$/u.test(input.target.replyToId)) ||
        !data.success ||
        data.data.tenantKey !== config.tenantKey
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      // Authentication precedes the message effect, so failures here are safe to retry.
      const access = await accessToken(input.signal).catch(() => ({
        status: "retryable" as const,
        errorCode: "tenant_token_transport_error",
      }));
      if (typeof access !== "string") {
        return access;
      }
      try {
        const reply = input.target.replyToId;
        const response = await post(
          `${base().replace(/\/$/u, "")}/open-apis/im/v1/messages${reply ? `/${encodeURIComponent(reply)}/reply` : "?receive_id_type=chat_id"}`,
          { authorization: `Bearer ${access}` },
          {
            msg_type: "text",
            content: JSON.stringify({ text: input.chunk.text }),
            ...(reply
              ? { reply_in_thread: Boolean(input.target.threadId) }
              : { receive_id: input.target.chatId }),
          },
          input.signal,
          config.timeoutMs,
        );
        if (!response.ok) {
          return failure(response);
        }
        const parsed = apiSchema.safeParse(await jsonResponse(response));
        if (!parsed.success) {
          return { status: "unknown", errorCode: "invalid_platform_response" };
        }
        if (parsed.data.code !== 0) {
          token = undefined;
          return { status: "rejected", errorCode: "feishu_api_error" };
        }
        return parsed.data.data?.message_id
          ? {
              status: "sent",
              receipt: { platformMessageId: parsed.data.data.message_id },
            }
          : { status: "unknown", errorCode: "invalid_platform_response" };
      } catch {
        return { status: "unknown", errorCode: "feishu_transport_error" };
      }
    },
  };
}
