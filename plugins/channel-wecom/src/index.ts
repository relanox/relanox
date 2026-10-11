import { randomUUID } from "node:crypto";
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { z } from "zod";
import { Connection, ingestText, checkedUrl, secret, secretRef } from "./transport.js";

const configSchema = z
  .object({
    botId: z.string().min(1),
    secret: secretRef,
    wsUrl: z.url().default("wss://openws.work.weixin.qq.com"),
    allowInsecureLoopback: z.boolean().default(false),
    heartbeatMs: z.number().int().min(1000).max(60_000).default(30_000),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((c, ctx) => {
    try {
      checkedUrl(c.wsUrl, true, c.allowInsecureLoopback);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid secure WebSocket URL" });
    }
  });
export type WeComConfig = z.infer<typeof configSchema>;
const frameSchema = z.object({
  cmd: z.string().optional(),
  headers: z.object({ req_id: z.string().min(1) }),
  body: z.unknown().optional(),
  errcode: z.number().int().optional(),
});
const messageSchema = z.object({
  msgid: z.string().min(1),
  aibotid: z.string().min(1),
  chatid: z.string().min(1).optional(),
  chattype: z.enum(["single", "group"]),
  from: z.object({ userid: z.string().min(1) }),
  msgtype: z.string(),
  text: z.object({ content: z.string().min(1) }).optional(),
});
const targetSchema = z
  .object({
    chattype: z.enum(["single", "group"]),
    scope: z.object({ botId: z.string().min(1), wsUrl: z.url() }).strict(),
  })
  .strict();
type Frame = z.infer<typeof frameSchema>;

export function createWeComChannel(): ChannelPlugin<WeComConfig> {
  let host: ChannelHost;
  let account: AccountConfig;
  let config: WeComConfig;
  let connection: Connection;
  let authenticated = false;
  const pending = new Map<string, { resolve(frame: Frame): void; reject(): void }>();
  async function request(cmd: string, body: unknown, signal: AbortSignal): Promise<Frame> {
    const id = randomUUID();
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const fail = () => {
        cleanup();
        reject(new Error("request_uncertain"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        pending.delete(id);
      };
      const timer = setTimeout(fail, 10_000);
      pending.set(id, {
        resolve: (frame) => {
          cleanup();
          resolve(frame);
        },
        reject: fail,
      });
      signal.addEventListener("abort", fail, { once: true });
      try {
        connection.send({
          cmd,
          headers: { req_id: id },
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        fail();
      }
    });
  }
  async function receive(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw);
    if (frame.errcode !== undefined) {
      pending.get(frame.headers.req_id)?.resolve(frame);
      return;
    }
    if (frame.cmd === "aibot_event_callback") {
      const event = z
        .object({ aibotid: z.string(), event: z.object({ eventtype: z.string() }) })
        .parse(frame.body);
      if (event.aibotid === config.botId && event.event.eventtype === "disconnected_event") {
        await connection.stop();
        host.connection("degraded", "bot_connection_replaced");
        host.observe.log("warn", "channel_connection_replaced", {
          errorCode: "bot_connection_replaced",
        });
      }
      return;
    }
    if (!authenticated || frame.cmd !== "aibot_msg_callback") {
      return;
    }
    const message = messageSchema.parse(frame.body);
    if (message.aibotid !== config.botId || message.from.userid === config.botId) {
      return;
    }
    if (message.msgtype !== "text" || !message.text) {
      host.observe.log("info", "channel_unsupported_input", {
        errorCode: "unsupported_message_type",
      });
      return;
    }
    const chatId = message.chattype === "group" ? message.chatid : message.from.userid;
    if (!chatId) {
      throw new Error("missing_group_address");
    }
    await ingestText(host, {
      source: {
        channel: "wecom",
        accountId: account.id,
        eventId: message.msgid,
      },
      senderId: message.from.userid,
      text: message.text.content,
      target: {
        channel: "wecom",
        accountId: account.id,
        chatId,
        replyToId: message.msgid,
        data: {
          chattype: message.chattype,
          scope: { botId: config.botId, wsUrl: new URL(config.wsUrl).href },
        },
      },
      receivedAt: Date.now(),
      context: null,
    });
  }
  return {
    id: "channel-wecom",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "wecom",
    // Independent sends have no documented idempotency promise. Escaping can double UTF-8 size.
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 2048,
      lengthUnit: "utf8",
      idempotentSend: false,
    },
    validateConfig: (value) => configSchema.parse(value),
    async setup(h, a, c) {
      host = h;
      account = a;
      config = configSchema.parse(c);
      connection = new Connection(
        host,
        async () => checkedUrl(config.wsUrl, true, config.allowInsecureLoopback),
        async () => {
          const result = await request(
            "aibot_subscribe",
            { bot_id: config.botId, secret: secret(config.secret) },
            connection.signal,
          );
          if (result.errcode !== 0) {
            connection.socket?.terminate();
            throw new Error("authentication_failed");
          }
          authenticated = true;
          connection.ready();
          let awaiting = false;
          connection.setHeartbeat(config.heartbeatMs, () => {
            if (awaiting) {
              connection.socket?.terminate();
              return;
            }
            awaiting = true;
            void (async () => {
              try {
                const response = await request("ping", undefined, connection.signal);
                if (response.errcode !== 0) {
                  connection.socket?.terminate();
                }
              } catch {
                connection.socket?.terminate();
              } finally {
                awaiting = false;
              }
            })();
          });
        },
        receive,
        () => {
          authenticated = false;
          for (const p of pending.values()) {
            p.reject();
          }
        },
        config.maxReconnectAttempts,
      );
    },
    start: (signal) => connection.start(signal),
    stop: () => connection.stop(),
    async send(input: SendInput): Promise<SendResult> {
      const target = targetSchema.safeParse(input.target.data);
      if (
        input.target.channel !== "wecom" ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      if (
        target.data.scope.botId !== config.botId ||
        target.data.scope.wsUrl !== new URL(config.wsUrl).href
      ) {
        return { status: "rejected", errorCode: "target_identity_changed" };
      }
      if (!authenticated) {
        return {
          status: "retryable",
          errorCode: "not_connected",
          retryAfterMs: 1000,
        };
      }
      const content = input.chunk.text.replaceAll(/[\\`*_{}[\]()#+.!>~|-]/gu, String.raw`\$&`);
      if (Buffer.byteLength(content) > 4096) {
        return { status: "rejected", errorCode: "text_too_long" };
      }
      try {
        const response = await request(
          "aibot_send_msg",
          {
            chatid: input.target.chatId,
            msgtype: "markdown",
            markdown: { content },
          },
          input.signal,
        );
        if (response.errcode === 0) {
          return { status: "sent", receipt: {} };
        }
        if (response.errcode === -1 || response.errcode === 45_009) {
          return {
            status: "retryable",
            errorCode: `wecom_${response.errcode}`,
            retryAfterMs: 1000,
          };
        }
        return { status: "rejected", errorCode: `wecom_${response.errcode}` };
      } catch {
        return { status: "unknown", errorCode: "transport_uncertain" };
      }
    },
  };
}
