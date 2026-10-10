import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { z } from "zod";
import {
  Connection,
  checkedUrl,
  httpJson,
  ingestText,
  post,
  RemoteError,
  secret,
  secretRef,
  sendFailure,
} from "./transport.js";

const configSchema = z
  .object({
    appId: z.string().min(1),
    clientSecret: secretRef,
    transport: z.literal("websocket").default("websocket"),
    apiBase: z.url().default("https://api.bot.qq.com"),
    allowProactive: z.boolean().default(false),
    allowInsecureLoopback: z.boolean().default(false),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((c, ctx) => {
    try {
      checkedUrl(c.apiBase, false, c.allowInsecureLoopback);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid secure API URL" });
    }
  });
export type QqConfig = z.infer<typeof configSchema>;
const frameSchema = z.object({
  op: z.number().int(),
  s: z.number().int().nonnegative().nullish(),
  t: z.string().optional(),
  d: z.unknown().optional(),
});
const messageSchema = z.object({
  id: z.string().min(1),
  author: z.object({
    user_openid: z.string().min(1).optional(),
    member_openid: z.string().min(1).optional(),
    bot: z.boolean().optional(),
  }),
  content: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  group_openid: z.string().min(1).optional(),
  message_type: z.number().int().optional(),
  msg_seq: z.number().int().optional(),
  message_scene: z.object({ ext: z.array(z.string()) }).optional(),
  attachments: z.array(z.unknown()).optional(),
});
const targetSchema = z
  .object({
    type: z.enum(["c2c", "group"]),
    msgId: z.string().min(1),
    messageAt: z.number().int().nonnegative(),
  })
  .strict();
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z
    .union([z.number(), z.string().regex(/^\d+$/u)])
    .transform(Number)
    .pipe(z.number().positive()),
});
const allocationSchema = z.object({
  next: z.number().int().positive(),
  allocations: z.record(
    z.string(),
    z.object({
      mode: z.enum(["passive", "proactive"]),
      seq: z.number().int().positive(),
    }),
  ),
});
const errorSchema = z.object({ code: z.number().int() });
function apiError(raw: unknown): SendResult | undefined {
  const error = errorSchema.safeParse(raw);
  if (!error.success || error.data.code === 0) {
    return undefined;
  }
  const code = error.data.code;
  if (code === 40_054_005) {
    return { status: "unknown", errorCode: "qq_duplicate_effect" };
  }
  if ([40_034_100, 50_055_001, 50_055_006].includes(code)) {
    return { status: "retryable", errorCode: `qq_${code}`, retryAfterMs: 1000 };
  }
  return { status: "rejected", errorCode: `qq_${code}` };
}

export function createQqChannel(): ChannelPlugin<QqConfig> {
  let host: ChannelHost;
  let account: AccountConfig;
  let config: QqConfig;
  let connection: Connection;
  let token: { value: string; credential: string; expiresAt: number } | undefined;
  let tokenFlight: Promise<string> | undefined;
  let session: string | undefined;
  let seq: number | null = null;
  let ready = false;
  let awaitingHeartbeat = false;
  let dispatchQueue = Promise.resolve();
  const api = (path: string) => `${config.apiBase.replace(/\/$/u, "")}${path}`;
  async function access(signal: AbortSignal): Promise<string> {
    const credential = secret(config.clientSecret);
    if (token && token.credential === credential && token.expiresAt > Date.now()) {
      return token.value;
    }
    if (tokenFlight) {
      return tokenFlight;
    }
    tokenFlight = (async () => {
      const raw = await httpJson(
        api("/app/getAppAccessToken"),
        post({ appId: config.appId, clientSecret: credential }),
        signal,
      );
      const error = errorSchema.safeParse(raw);
      if (error.success && error.data.code !== 0) {
        throw new RemoteError({
          status: error.data.code === 100_001 ? "retryable" : "rejected",
          errorCode: `qq_token_${error.data.code}`,
        });
      }
      const body = tokenSchema.parse(raw);
      token = {
        value: body.access_token,
        credential,
        expiresAt: Date.now() + Math.max(1, body.expires_in - 60) * 1000,
      };
      return token.value;
    })();
    try {
      return await tokenFlight;
    } finally {
      tokenFlight = undefined;
    }
  }
  const heartbeat = () => {
    if (awaitingHeartbeat) {
      connection.socket?.terminate();
      return;
    }
    awaitingHeartbeat = true;
    connection.send({ op: 1, d: seq });
  };
  async function ingestMessage(eventType: string, raw: unknown): Promise<void> {
    const message = messageSchema.parse(raw);
    if (message.author.bot) {
      return;
    }
    if (
      (message.message_type !== undefined && message.message_type !== 0) ||
      message.attachments?.length ||
      !message.content.trim()
    ) {
      host.observe.log("info", "channel_unsupported_input", {
        errorCode: "unsupported_message_type",
      });
      return;
    }
    const group = eventType === "GROUP_AT_MESSAGE_CREATE";
    const senderId = group ? message.author.member_openid : message.author.user_openid;
    const chatId = group ? message.group_openid : senderId;
    if (!senderId || !chatId) {
      throw new Error("missing_sender_address");
    }
    // Current docs distinguish indexed parts; never persist auth_token from message_scene.
    const index = message.message_scene?.ext
      .find((entry) => entry.startsWith("msg_idx="))
      ?.slice(8);
    const eventId = JSON.stringify([eventType, message.id, index ?? message.msg_seq ?? null]);
    await ingestText(host, {
      source: { channel: "qq", accountId: account.id, eventId },
      senderId,
      text: message.content,
      target: {
        channel: "qq",
        accountId: account.id,
        chatId,
        replyToId: message.id,
        data: {
          type: group ? "group" : "c2c",
          msgId: message.id,
          messageAt: Date.parse(message.timestamp),
        },
      },
      receivedAt: Date.now(),
      context: null,
    });
  }
  async function dispatch(frame: z.infer<typeof frameSchema>): Promise<void> {
    if (frame.t === "READY") {
      const body = z.object({ session_id: z.string().min(1) }).parse(frame.d);
      session = body.session_id;
      ready = true;
      connection.ready();
    } else if (frame.t === "RESUMED") {
      ready = true;
      connection.ready();
    } else if (
      (ready || session !== undefined) &&
      (frame.t === "C2C_MESSAGE_CREATE" || frame.t === "GROUP_AT_MESSAGE_CREATE")
    ) {
      await ingestMessage(frame.t, frame.d);
    }
    // Resume cursor only advances after durable handoff. Control frames bypass this queue.
    if (typeof frame.s === "number") {
      seq = frame.s;
    }
  }
  async function receive(raw: unknown): Promise<void> {
    const frame = frameSchema.parse(raw);
    switch (frame.op) {
      case 10: {
        const body = z
          .object({
            heartbeat_interval: z.number().int().min(1000).max(300_000),
          })
          .parse(frame.d);
        const value = await access(connection.signal);
        connection.send(
          session && seq !== null
            ? {
                op: 6,
                d: { token: `QQBot ${value}`, session_id: session, seq },
              }
            : {
                op: 2,
                d: {
                  token: `QQBot ${value}`,
                  intents: 1 << 25,
                  shard: [0, 1],
                  properties: {},
                },
              },
        );
        awaitingHeartbeat = false;
        connection.setHeartbeat(body.heartbeat_interval, heartbeat);
        return;
      }
      case 11: {
        awaitingHeartbeat = false;
        return;
      }
      case 1: {
        awaitingHeartbeat = false;
        heartbeat();
        return;
      }
      case 7: {
        connection.socket?.close();
        return;
      }
      case 9: {
        if (frame.d !== true) {
          session = undefined;
          seq = null;
        }
        connection.socket?.close();
        return;
      }
      case 0: {
        const task = dispatchQueue.then(() => dispatch(frame));
        dispatchQueue = task.catch(() => {});
        await task;
      }
    }
  }
  async function allocate(
    input: SendInput,
    target: z.infer<typeof targetSchema>,
  ): Promise<{ mode: "passive" | "proactive"; seq: number } | SendResult> {
    const key = `reply:${JSON.stringify([target.type, input.target.chatId, target.msgId])}`;
    const max = target.type === "c2c" ? 4 : 5;
    const windowMs = target.type === "c2c" ? 3_600_000 : 300_000;
    for (let attempt = 0; attempt < 32; attempt++) {
      input.signal.throwIfAborted();
      const entry = await host.state.get(key);
      const state = entry
        ? allocationSchema.parse(entry.value)
        : {
            next: 1,
            allocations: {} as Record<string, { mode: "passive" | "proactive"; seq: number }>,
          };
      const existing = Object.hasOwn(state.allocations, input.chunk.idempotencyKey)
        ? state.allocations[input.chunk.idempotencyKey]
        : undefined;
      if (existing) {
        if (existing.mode === "passive" && Date.now() >= target.messageAt + windowMs) {
          return { status: "rejected", errorCode: "passive_window_expired" };
        }
        return existing;
      }
      const passive = Date.now() < target.messageAt + windowMs && state.next <= max;
      if (!passive && !config.allowProactive) {
        return {
          status: "rejected",
          errorCode: state.next > max ? "passive_reply_limit" : "passive_window_expired",
        };
      }
      // Avoid an unbounded plugin-state map. One inbound can emit at most 256 text chunks.
      if (Object.keys(state.allocations).length >= 256) {
        return { status: "rejected", errorCode: "reply_chunk_limit" };
      }
      const allocation = {
        mode: passive ? ("passive" as const) : ("proactive" as const),
        seq: state.next,
      };
      const result = await host.state.compareAndSet({
        key,
        expectedVersion: entry?.version ?? null,
        value: {
          next: state.next + 1,
          allocations: {
            ...state.allocations,
            [input.chunk.idempotencyKey]: allocation,
          },
        },
      });
      if (result.status === "updated") {
        return allocation;
      }
    }
    return {
      status: "retryable",
      errorCode: "sequence_contention",
      retryAfterMs: 1000,
    };
  }
  return {
    id: "channel-qq",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "qq",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 2000,
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
        async (signal) => {
          const value = await access(signal);
          const raw = await httpJson(
            api("/gateway"),
            { headers: { Authorization: `QQBot ${value}` } },
            signal,
          );
          const body = z.object({ url: z.url() }).parse(raw);
          return checkedUrl(body.url, true, config.allowInsecureLoopback);
        },
        async () => {},
        receive,
        (code) => {
          ready = false;
          awaitingHeartbeat = false;
          if (
            code === 4006 ||
            code === 4007 ||
            (code !== undefined && code >= 4900 && code <= 4913)
          ) {
            session = undefined;
            seq = null;
          }
          if (
            code !== undefined &&
            [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)
          ) {
            void connection.stop().then(() => {
              host.connection("degraded", `qq_gateway_${code}`);
              return code;
            });
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
        input.target.channel !== "qq" ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      let allocation: Awaited<ReturnType<typeof allocate>>;
      try {
        allocation = await allocate(input, target.data);
      } catch {
        return { status: "retryable", errorCode: "sequence_unavailable" };
      }
      if ("status" in allocation) {
        return allocation;
      }
      let credential: string;
      try {
        credential = await access(input.signal);
      } catch (error) {
        if (error instanceof RemoteError && error.result.status !== "unknown") {
          return error.result;
        }
        return { status: "retryable", errorCode: "token_unavailable" };
      }
      try {
        const raw = await httpJson(
          api(
            `/v2/${target.data.type === "c2c" ? "users" : "groups"}/${encodeURIComponent(input.target.chatId)}/messages`,
          ),
          post(
            {
              content: input.chunk.text,
              msg_type: 0,
              ...(allocation.mode === "passive"
                ? { msg_id: target.data.msgId, msg_seq: allocation.seq }
                : {}),
            },
            { Authorization: `QQBot ${credential}` },
          ),
          input.signal,
        );
        const failure = apiError(raw);
        if (failure) {
          return failure;
        }
        const response = z.object({ id: z.string().min(1) }).parse(raw);
        return { status: "sent", receipt: { platformMessageId: response.id } };
      } catch (error) {
        if (error instanceof RemoteError && error.result.errorCode === "http_401") {
          token = undefined;
          return {
            status: "retryable",
            errorCode: "token_expired",
            retryAfterMs: 1000,
          };
        }
        if (error instanceof RemoteError) {
          const failure = apiError(error.body);
          if (failure) {
            return failure;
          }
        }
        return sendFailure(error);
      }
    },
  };
}
