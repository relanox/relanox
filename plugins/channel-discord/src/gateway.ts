import { setTimeout as delay } from "node:timers/promises";
import type { AccountConfig, ChannelHost } from "@relanox/sdk";
import { WebSocket } from "ws";
import { z } from "zod";
import type { DiscordConfig } from "./config.js";
import { packetSchema, sessionSchema, readySchema, messageSchema } from "./schemas.js";
import { frameText, waitForStop } from "./socket.js";
import { address, credential, id, ingest, jsonResponse } from "./transport.js";

type Session = z.infer<typeof sessionSchema>;

export function createDiscordGateway(
  config: DiscordConfig,
  host: ChannelHost,
  account: AccountConfig,
  environment: NodeJS.ProcessEnv,
) {
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  let socket: WebSocket | undefined;
  let session: Session | undefined;
  let fatal = false;
  const identity = () => ({
    botId: config.botUserId,
    apiBaseUrl: new URL(config.apiBaseUrl).toString().replace(/\/$/u, ""),
  });
  async function persist() {
    if (!session) {
      return;
    }
    const previous = await host.state.get("gateway-session");
    const result = await host.state.compareAndSet({
      key: "gateway-session",
      expectedVersion: previous?.version ?? null,
      value: session,
    });
    if (result.status !== "updated") {
      throw new Error("session_conflict");
    }
  }
  async function clearSession() {
    session = undefined;
    const previous = await host.state.get("gateway-session");
    if (previous) {
      await host.state.delete("gateway-session", previous.version);
    }
  }
  async function messageTarget(
    message: z.infer<typeof messageSchema>,
    signal: AbortSignal,
  ): Promise<{ chatId: string; threadId?: string }> {
    if (!message.guild_id) {
      return { chatId: message.channel_id };
    }
    const response = await fetch(
      `${config.apiBaseUrl.replace(/\/$/u, "")}/channels/${encodeURIComponent(message.channel_id)}`,
      {
        headers: { authorization: `Bot ${credential(config.botToken, environment)}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new Error("channel_lookup_failed");
    }
    const channel = z
      .looseObject({ id, type: z.number().int(), parent_id: id.nullable().optional() })
      .parse(await jsonResponse(response));
    if (channel.id !== message.channel_id) {
      throw new Error("channel_lookup_mismatch");
    }
    if (![10, 11, 12].includes(channel.type)) {
      return { chatId: message.channel_id };
    }
    if (!channel.parent_id) {
      throw new Error("thread_parent_missing");
    }
    return { chatId: channel.parent_id, threadId: message.channel_id };
  }
  async function connect(signal: AbortSignal) {
    const botToken = credential(config.botToken, environment);
    const url = new URL(
      address(session?.resume_gateway_url ?? config.gatewayUrl, config.allowInsecureLoopback, true),
    );
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    const ws = new WebSocket(url, {
      maxPayload: 1_048_576,
      handshakeTimeout: config.timeoutMs,
    });
    socket = ws;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let interval = 0;
    let acknowledged = true;
    let pending = 0;
    let failed = false;
    let chain = Promise.resolve();
    let sequence = session?.seq ?? null;
    const send = (value: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(value));
      }
    };
    const beat = () => {
      if (!acknowledged) {
        ws.terminate();
        return;
      }
      acknowledged = false;
      send({ op: 1, d: sequence });
      heartbeat = setTimeout(beat, interval);
    };
    const abort = () => {
      ws.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    await new Promise<void>((resolve) => {
      ws.on("error", () => {
        host.connection("degraded", "gateway_transport_error");
        ws.terminate();
      });
      ws.on("close", (code) => {
        if (heartbeat) {
          clearTimeout(heartbeat);
        }
        signal.removeEventListener("abort", abort);
        host.connection("disconnected");
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
          fatal = true;
          host.connection("degraded", "gateway_configuration_error");
        }
        if ([4007, 4009].includes(code)) {
          session = undefined;
        }
        resolve();
      });
      ws.on("message", (raw) => {
        let packet: z.infer<typeof packetSchema>;
        try {
          packet = packetSchema.parse(JSON.parse(frameText(raw)));
        } catch {
          host.connection("degraded", "invalid_gateway_frame");
          ws.terminate();
          return;
        }
        if (packet.op === 10) {
          const hello = z
            .object({
              heartbeat_interval: z.number().int().min(10).max(300_000),
            })
            .safeParse(packet.d);
          if (!hello.success || interval) {
            ws.terminate();
            return;
          }
          interval = hello.data.heartbeat_interval;
          heartbeat = setTimeout(beat, Math.random() * interval);
          send(
            session
              ? {
                  op: 6,
                  d: {
                    token: botToken,
                    session_id: session.session_id,
                    seq: session.seq,
                  },
                }
              : {
                  op: 2,
                  d: {
                    token: botToken,
                    intents: config.intents,
                    properties: {
                      os: process.platform,
                      browser: "relanox",
                      device: "relanox",
                    },
                  },
                },
          );
          return;
        }
        if (packet.op === 11) {
          acknowledged = true;
          return;
        }
        if (packet.op === 1) {
          acknowledged = false;
          send({ op: 1, d: sequence });
          return;
        }
        if (packet.op === 7) {
          ws.terminate();
          return;
        }
        if (packet.op === 9) {
          const invalidate = async () => {
            if (packet.d !== true) {
              await clearSession();
            }
            ws.terminate();
          };
          chain = chain.then(invalidate).catch(() => {
            ws.terminate();
          });
          return;
        }
        if (packet.op !== 0 || packet.s === null || packet.s === undefined) {
          return;
        }
        if (++pending > 64) {
          ws.terminate();
          return;
        }
        const consume = async () => {
          if (failed || signal.aborted) {
            return;
          }
          if (packet.t === "READY") {
            const ready = readySchema.parse(packet.d);
            if (ready.user.id !== config.botUserId) {
              fatal = true;
              throw new Error("bot_identity_mismatch");
            }
            address(ready.resume_gateway_url, config.allowInsecureLoopback, true);
            session = {
              session_id: ready.session_id,
              resume_gateway_url: ready.resume_gateway_url,
              seq: packet.s as number,
              botId: ready.user.id,
              apiBaseUrl: identity().apiBaseUrl,
              gatewayUrl: new URL(config.gatewayUrl).toString(),
            };
            host.connection("connected");
          } else if (packet.t === "RESUMED") {
            host.connection("connected");
          } else if (packet.t === "MESSAGE_CREATE") {
            const message = messageSchema.parse(packet.d);
            if (
              !message.author.bot &&
              !message.webhook_id &&
              message.author.id !== config.botUserId &&
              [0, 19].includes(message.type) &&
              message.content
            ) {
              const target = await messageTarget(message, signal);
              await ingest(host, {
                source: {
                  channel: "discord",
                  accountId: account.id,
                  eventId: message.id,
                },
                senderId: message.author.id,
                text: message.content,
                target: {
                  channel: "discord",
                  accountId: account.id,
                  ...target,
                  replyToId: message.id,
                  data: identity(),
                },
                context: message.guild_id ? { guildId: message.guild_id } : {},
                receivedAt: Date.now(),
              });
            } else {
              host.observe.count("relanox_inbound_total", {
                channel: "discord",
                operation: "ingest",
                outcome: "rejected",
                error_class: "unsupported",
              });
            }
          }
          sequence = packet.s as number;
          if (session) {
            session.seq = sequence;
            await persist();
          }
        };
        chain = chain
          .then(consume)
          .catch(() => {
            failed = true;
            host.connection("degraded", "gateway_ingest_error");
            ws.terminate();
          })
          .finally(() => {
            pending--;
          });
      });
    });
    // Do not reconnect using a cursor while its earlier dispatch is still committing.
    await chain;
  }
  async function run(signal: AbortSignal) {
    const saved = await host.state.get("gateway-session");
    const parsed = sessionSchema.safeParse(saved?.value);
    session = undefined;
    if (
      parsed.success &&
      parsed.data.botId === config.botUserId &&
      parsed.data.apiBaseUrl === identity().apiBaseUrl &&
      parsed.data.gatewayUrl === new URL(config.gatewayUrl).toString()
    ) {
      session = parsed.data;
    }
    let failures = 0;
    while (!signal.aborted && !fatal) {
      try {
        await connect(signal);
      } catch {
        host.connection("degraded", "gateway_connection_error");
      }
      if (signal.aborted || fatal) {
        break;
      }
      await delay(
        Math.min(30_000, config.reconnectDelayMs * 2 ** Math.min(failures++, 5)),
        undefined,
        { signal },
      ).catch(() => {});
    }
  }
  return {
    async start(signal: AbortSignal) {
      if (task) {
        return;
      }
      controller = new AbortController();
      fatal = false;
      task = run(AbortSignal.any([signal, controller.signal])).catch(() => {
        host.connection("degraded", "gateway_lifecycle_error");
      });
    },
    async stop() {
      controller?.abort();
      socket?.terminate();
      await waitForStop(task, config.timeoutMs);
      task = undefined;
    },
  };
}
