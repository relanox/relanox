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
  phoneNumberId: identifier,
  businessAccountId: identifier,
  appSecret: secretRef,
  verifyToken: secretRef,
  accessToken: secretRef,
  apiVersion: z.string().regex(/^v[0-9]+\.[0-9]+$/u),
  apiBase: z.url().default("https://graph.facebook.com"),
  allowLoopback: z.boolean().default(false),
});
export type WhatsAppConfig = z.infer<typeof configSchema>;
const messageSchema = z.object({
  id: identifier,
  from: identifier,
  timestamp: z.string().regex(/^[0-9]+$/u),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});
const valueSchema = z.object({
  metadata: z.object({ phone_number_id: identifier }),
  messages: z.array(messageSchema).optional(),
});
const webhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: identifier,
      changes: z.array(z.object({ field: z.string(), value: valueSchema })),
    }),
  ),
});
const targetSchema = z.strictObject({
  phoneNumberId: identifier,
  businessAccountId: identifier,
  apiBase: z.url(),
  customer: identifier,
  windowUntil: z.number().int().nonnegative(),
});
const responseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  messages: z.array(z.object({ id: identifier })).min(1),
});

function windowKey(config: WhatsAppConfig, customer: string): string {
  return `window:${JSON.stringify([config.apiBase, config.businessAccountId, config.phoneNumberId, customer])}`;
}

async function updateWindow(host: ChannelHost, key: string, until: number): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previous = await host.state.get(key);
    const previousUntil = previous ? z.number().int().parse(previous.value) : 0;
    if (previousUntil >= until) {
      return;
    }
    const result = await host.state.compareAndSet({
      key,
      expectedVersion: previous?.version ?? null,
      value: until,
    });
    if (result.status === "updated") {
      return;
    }
  }
  throw new Error("window_conflict");
}

async function receiveMessage(
  host: ChannelHost,
  account: AccountConfig,
  config: WhatsAppConfig,
  message: z.infer<typeof messageSchema>,
): Promise<void> {
  const timestamp = Number(message.timestamp) * 1000;
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now() + 300_000) {
    throw new Error("invalid_timestamp");
  }
  const windowUntil = timestamp + 86_400_000;
  await updateWindow(host, windowKey(config, message.from), windowUntil);
  if (message.type !== "text" || !message.text?.body) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_empty_text" });
    return;
  }
  await ingest(host, {
    source: { channel: "whatsapp", accountId: account.id, eventId: message.id },
    senderId: message.from,
    text: message.text.body,
    receivedAt: Date.now(),
    context: null,
    target: {
      channel: "whatsapp",
      accountId: account.id,
      chatId: message.from,
      replyToId: message.id,
      data: {
        phoneNumberId: config.phoneNumberId,
        businessAccountId: config.businessAccountId,
        apiBase: config.apiBase,
        customer: message.from,
        windowUntil,
      },
    },
  });
}

async function receive(
  host: ChannelHost,
  account: AccountConfig,
  config: WhatsAppConfig,
  body: z.infer<typeof webhookSchema>,
): Promise<void> {
  for (const entry of body.entry) {
    if (entry.id !== config.businessAccountId) {
      throw new Error("wrong_business_account");
    }
    for (const change of entry.changes) {
      if (change.field !== "messages") {
        continue;
      }
      if (change.value.metadata.phone_number_id !== config.phoneNumberId) {
        throw new Error("wrong_phone_account");
      }
      for (const message of change.value.messages ?? []) {
        await receiveMessage(host, account, config, message);
      }
    }
  }
}

export function createWhatsAppChannel(): ChannelPlugin<WhatsAppConfig> {
  let runtime: { host: ChannelHost; account: AccountConfig; config: WhatsAppConfig } | undefined;
  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== "whatsapp"
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const { host, config } = runtime;
    const parsed = targetSchema.safeParse(input.target.data);
    if (!parsed.success) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const target = parsed.data;
    if (target.customer !== input.target.chatId || target.phoneNumberId !== config.phoneNumberId) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    if (
      target.businessAccountId !== config.businessAccountId ||
      target.apiBase !== config.apiBase
    ) {
      return { status: "rejected", errorCode: "target_identity_changed" };
    }
    const latest = await host.state.get(windowKey(config, target.customer));
    const until = Math.max(target.windowUntil, latest ? z.number().int().parse(latest.value) : 0);
    if (Date.now() >= until) {
      return { status: "rejected", errorCode: "customer_window_expired" };
    }
    try {
      const response = await request(
        endpoint(
          `${config.apiBase}/${config.apiVersion}/${encodeURIComponent(target.phoneNumberId)}/messages`,
          config.allowLoopback,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret(config.accessToken)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: target.customer,
            type: "text",
            text: { body: input.chunk.text, preview_url: false },
          }),
        },
        input.signal,
      );
      if (!response.ok) {
        return failure(response);
      }
      const decoded = responseSchema.parse(await response.json());
      const message = decoded.messages[0];
      if (!message) {
        return unavailable();
      }
      return { status: "sent", receipt: { platformMessageId: message.id } };
    } catch {
      return unavailable();
    }
  }
  return {
    id: "channel-whatsapp",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "whatsapp",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 4096,
      lengthUnit: "utf16",
      idempotentSend: false,
    },
    validateConfig(value) {
      const config = configSchema.parse(value);
      const apiBase = endpoint(config.apiBase, config.allowLoopback);
      if (/[?#]/u.test(apiBase.href)) {
        throw new Error("invalid_api_base");
      }
      config.apiBase = apiBase.href.replace(/\/+$/u, "");
      return config;
    },
    async setup(host, account, config) {
      runtime = { host, account, config };
      host.mountHttp("/webhook", async (incoming) => {
        if (incoming.method === "GET") {
          const query = new URL(incoming.url).searchParams;
          if (
            query.get("hub.mode") !== "subscribe" ||
            query.get("hub.verify_token") !== secret(config.verifyToken)
          ) {
            return new Response(null, { status: 403 });
          }
          const challenge = query.get("hub.challenge");
          return challenge ? new Response(challenge) : new Response(null, { status: 400 });
        }
        if (incoming.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const bytes = await rawBody(incoming);
        if (
          !signed(
            bytes,
            incoming.headers.get("x-hub-signature-256"),
            secret(config.appSecret),
            "hex",
            "sha256=",
          )
        ) {
          return new Response(null, { status: 401 });
        }
        const decoded = webhookSchema.safeParse(parseBody(bytes));
        if (!decoded.success) {
          return new Response(null, { status: 400 });
        }
        await receive(host, account, config, decoded.data);
        return Response.json({});
      });
    },
    send,
  };
}
