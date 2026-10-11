import type { AccountConfig, ChannelHost, ChannelPlugin, SendResult } from "@relanox/sdk";
import { z } from "zod";
import {
  address,
  bytes,
  credential,
  equal,
  failure,
  ingest,
  jsonResponse,
  post,
  secret,
  transportOptions,
} from "./transport.js";

const configSchema = z.strictObject({
  botToken: secret,
  webhookSecret: secret,
  apiBaseUrl: z.string().default("https://api.telegram.org"),
  ...transportOptions,
});
export type TelegramConfig = z.infer<typeof configSchema>;
const messageSchema = z.looseObject({
  message_id: z.number().int().positive(),
  message_thread_id: z.number().int().positive().optional(),
  from: z.looseObject({ id: z.number().int(), is_bot: z.boolean() }).optional(),
  chat: z.looseObject({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
  }),
  text: z.string().max(1_048_576).optional(),
});
const updateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
});
const responseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.looseObject({ message_id: z.number().int() }).optional(),
  error_code: z.number().optional(),
  parameters: z.looseObject({ retry_after: z.number().positive().optional() }).optional(),
});

async function sendOutcome(response: Response): Promise<SendResult> {
  const result = responseSchema.safeParse(await jsonResponse(response).catch(() => null));
  if (response.status === 429) {
    return result.success && result.data.parameters?.retry_after
      ? {
          status: "retryable",
          errorCode: "rate_limited",
          retryAfterMs: result.data.parameters.retry_after * 1000,
        }
      : failure(response);
  }
  if (!result.success) {
    return response.ok
      ? { status: "unknown", errorCode: "invalid_platform_response" }
      : failure(response);
  }
  if (!result.data.ok) {
    if (result.data.error_code === 429) {
      return {
        status: "retryable",
        errorCode: "rate_limited",
        ...(result.data.parameters?.retry_after
          ? { retryAfterMs: result.data.parameters.retry_after * 1000 }
          : {}),
      };
    }
    return {
      status: result.data.error_code && result.data.error_code < 500 ? "rejected" : "unknown",
      errorCode: "telegram_api_error",
    };
  }
  if (!response.ok || !result.data.result) {
    return { status: "unknown", errorCode: "invalid_platform_response" };
  }
  return {
    status: "sent",
    receipt: { platformMessageId: String(result.data.result.message_id) },
  };
}

/** One factory instance per configured account. Credentials are resolved only at use. */
export function createTelegramChannel(
  environment: NodeJS.ProcessEnv = process.env,
): ChannelPlugin<TelegramConfig> {
  let host: ChannelHost;
  let account: AccountConfig;
  let config: TelegramConfig;
  return {
    id: "channel-telegram",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "telegram",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 4096,
      lengthUnit: "codepoint",
      idempotentSend: false,
    },
    validateConfig(input) {
      const parsed = configSchema.parse(input);
      address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
      return parsed;
    },
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost;
      account = nextAccount;
      config = nextConfig;
      if (!/^\d+:[A-Za-z0-9_-]+$/u.test(credential(config.botToken, environment))) {
        throw new Error("invalid_bot_token");
      }
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(credential(config.webhookSecret, environment))) {
        throw new Error("invalid_webhook_secret");
      }
      host.mountHttp("/webhook", async (request) => {
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        if (
          !equal(
            request.headers.get("x-telegram-bot-api-secret-token") ?? "",
            credential(config.webhookSecret, environment),
          )
        ) {
          return new Response(null, { status: 401 });
        }
        let raw: Buffer;
        try {
          raw = await bytes(request);
        } catch {
          return new Response(null, { status: 413 });
        }
        let update: z.infer<typeof updateSchema>;
        try {
          update = updateSchema.parse(JSON.parse(raw.toString("utf8")));
        } catch {
          return new Response(null, { status: 400 });
        }
        const message = update.message;
        if (
          !message?.text ||
          !message.from ||
          message.from.is_bot ||
          message.chat.type === "channel"
        ) {
          host.observe.count("relanox_inbound_total", {
            channel: "telegram",
            operation: "ingest",
            outcome: "rejected",
            error_class: "unsupported",
          });
          return new Response(null, { status: 204 });
        }
        try {
          await ingest(host, {
            source: {
              channel: "telegram",
              accountId: account.id,
              eventId: String(update.update_id),
            },
            senderId: String(message.from.id),
            text: message.text,
            target: {
              channel: "telegram",
              accountId: account.id,
              chatId: String(message.chat.id),
              ...(message.message_thread_id ? { threadId: String(message.message_thread_id) } : {}),
              replyToId: String(message.message_id),
              data: null,
            },
            receivedAt: Date.now(),
            context: { messageId: String(message.message_id) },
          });
          return new Response(null, { status: 204 });
        } catch {
          return new Response(null, { status: 503 });
        }
      });
    },
    async send(input) {
      if (
        input.target.accountId !== account.id ||
        input.target.channel !== "telegram" ||
        !/^-?\d+$/u.test(input.target.chatId) ||
        (input.target.threadId && !/^\d+$/u.test(input.target.threadId)) ||
        (input.target.replyToId && !/^\d+$/u.test(input.target.replyToId))
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      try {
        const token = credential(config.botToken, environment);
        if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token)) {
          return { status: "rejected", errorCode: "invalid_bot_token" };
        }
        const response = await post(
          `${config.apiBaseUrl.replace(/\/$/u, "")}/bot${token}/sendMessage`,
          {},
          {
            chat_id: input.target.chatId,
            text: input.chunk.text,
            ...(input.target.threadId ? { message_thread_id: Number(input.target.threadId) } : {}),
            ...(input.target.replyToId
              ? {
                  reply_parameters: {
                    message_id: Number(input.target.replyToId),
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            link_preview_options: { is_disabled: true },
          },
          input.signal,
          config.timeoutMs,
        );
        return await sendOutcome(response);
      } catch {
        return { status: "unknown", errorCode: "telegram_transport_error" };
      }
    },
  };
}
