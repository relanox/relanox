import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelHost, Storage } from "@relanox/sdk";
import { createSqliteStorage } from "@relanox/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createDiscordChannel } from "../src/index.js";
import { peer, recorder, sendInput } from "./peer.js";

const environment = { BOT: "discord-token" };
const account = {
  id: "dc",
  channel: "discord" as const,
  config: null,
  allowedSenders: ["42"],
};
const target = {
  channel: "discord" as const,
  accountId: "dc",
  chatId: "456",
  replyToId: "789",
  data: null,
};
const cleanup: (() => Promise<void>)[] = [];
function readFrame(raw: RawData): Record<string, unknown> {
  if (!Buffer.isBuffer(raw)) {
    throw new TypeError("unexpected_gateway_frame_bytes");
  }
  const frame: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new TypeError("unexpected_gateway_frame_shape");
  }
  return frame as Record<string, unknown>;
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
async function setup(
  apiBaseUrl = "https://discord.com/api/v10",
  gatewayUrl = "wss://gateway.discord.gg",
  onIngest?: Parameters<typeof recorder>[0],
  storage?: Storage,
) {
  const plugin = createDiscordChannel(environment);
  const recorded = recorder(onIngest);
  const db = storage ?? createSqliteStorage({ filename: ":memory:", busyTimeoutMs: 5000 });
  await db.migrate();
  if (!storage) {
    cleanup.push(() => db.close());
  }
  const namespace = { pluginId: "channel-discord", ownerId: "dc" };
  const host: ChannelHost = {
    ...recorded.host,
    state: {
      get: (key) => db.getState(namespace, key),
      list: (input) => db.listState(namespace, input),
      compareAndSet: (input) => db.compareAndSetState(namespace, input),
      delete: (key, version) => db.deleteState(namespace, key, version),
    },
  };
  await plugin.setup(
    host,
    account,
    plugin.validateConfig({
      botToken: { env: "BOT" },
      botUserId: "999",
      apiBaseUrl,
      gatewayUrl,
      reconnectDelayMs: 100,
      allowInsecureLoopback: true,
    }),
  );
  return { plugin, db, ...recorded };
}
async function gateway() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  cleanup.push(async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });
  return { wss, url };
}
describe("discord native Gateway and REST", () => {
  it.each(["sender_not_allowed", "unbound_conversation"])(
    "continues the Gateway after terminal core policy rejection: %s",
    async (code) => {
      const remote = await gateway();
      const test = await setup(undefined, remote.url, async (input) => {
        if (input.source.eventId === "788") {
          throw Object.assign(new Error(code), { code });
        }
      });
      cleanup.unshift(async () => {
        await test.plugin.stop?.();
      });
      remote.wss.on("connection", (ws) => {
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
        ws.on("message", (raw) => {
          const frame = readFrame(raw);
          if (frame.op === 1) {
            ws.send(JSON.stringify({ op: 11 }));
          }
          if (frame.op !== 2) {
            return;
          }
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "policy-session",
                resume_gateway_url: remote.url,
                user: { id: "999" },
              },
            }),
          );
          for (const [seq, messageId] of [
            [2, "788"],
            [3, "789"],
          ] as const) {
            ws.send(
              JSON.stringify({
                op: 0,
                s: seq,
                t: "MESSAGE_CREATE",
                d: {
                  id: messageId,
                  channel_id: "456",
                  content: "hello",
                  author: { id: "42" },
                  type: 0,
                },
              }),
            );
          }
        });
      });
      await test.plugin.start?.(new AbortController().signal);
      await expect.poll(() => test.received.map((input) => input.source.eventId)).toEqual(["789"]);
      await expect
        .poll(
          async () =>
            (
              await test.db.getState(
                { pluginId: "channel-discord", ownerId: "dc" },
                "gateway-session",
              )
            )?.value,
        )
        .toMatchObject({ session_id: "policy-session", seq: 3 });
      expect(test.connections).not.toContain("degraded");
    },
  );

  it("preserves canceled-send uncertainty without starting an HTTP effect", async () => {
    const remote = await peer(() => ({ body: { id: "900" } }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    const controller = new AbortController();
    controller.abort();
    expect(await test.plugin.send(sendInput(target, controller.signal))).toEqual({
      status: "unknown",
      errorCode: "discord_transport_error",
    });
    expect(remote.requests).toEqual([]);
  });

  it("identifies with intents, maintains heartbeat, filters bots and stops without reconnect", async () => {
    const remote = await gateway();
    const test = await setup(undefined, remote.url);
    cleanup.unshift(async () => {
      await test.plugin.stop?.();
    });
    const frames: Record<string, unknown>[] = [];
    let connected = 0;
    remote.wss.on("connection", (ws) => {
      connected++;
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
      ws.on("message", (raw) => {
        const frame = readFrame(raw);
        frames.push(frame);
        if (frame.op === 1) {
          ws.send(JSON.stringify({ op: 11 }));
        }
        if (frame.op === 2) {
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "session-1",
                resume_gateway_url: remote.url,
                user: { id: "999" },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 2,
              t: "MESSAGE_CREATE",
              d: {
                id: "788",
                channel_id: "456",
                content: "loop",
                author: { id: "888", bot: true },
                type: 0,
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 3,
              t: "MESSAGE_CREATE",
              d: {
                id: "789",
                channel_id: "456",
                content: "hello",
                author: { id: "42", bot: false },
                type: 19,
              },
            }),
          );
        }
      });
    });
    await test.plugin.start?.(new AbortController().signal);
    await expect.poll(() => test.received.length).toBe(1);
    expect(frames).toContainEqual({
      op: 2,
      d: {
        token: "discord-token",
        intents: 37_377,
        properties: {
          os: process.platform,
          browser: "relanox",
          device: "relanox",
        },
      },
    });
    expect(test.received[0]).toMatchObject({
      source: { channel: "discord", accountId: "dc", eventId: "789" },
      senderId: "42",
      text: "hello",
      target,
    });
    await expect.poll(() => frames.some((frame) => frame.op === 1 && frame.d === 3)).toBe(true);
    await test.plugin.stop?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 180);
    });
    expect(connected).toBe(1);
  });

  it("resumes durable sequence across new plugin and SQLite connection after committed handoff", async () => {
    const remote = await gateway();
    const directory = await mkdtemp(join(tmpdir(), "relanox-discord-"));
    const filename = join(directory, "state.db");
    let db = createSqliteStorage({ filename, busyTimeoutMs: 5000 });
    let active: Awaited<ReturnType<typeof setup>> | undefined;
    cleanup.unshift(async () => {
      await active?.plugin.stop?.();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    });
    const frames: Record<string, unknown>[] = [];
    remote.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      ws.on("message", (raw) => {
        const frame = readFrame(raw);
        frames.push(frame);
        if (frame.op === 1) {
          ws.send(JSON.stringify({ op: 11 }));
        }
        if (frame.op === 2) {
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "durable-session",
                resume_gateway_url: remote.url,
                user: { id: "999" },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 2,
              t: "MESSAGE_CREATE",
              d: {
                id: "789",
                channel_id: "456",
                content: "hello",
                author: { id: "42" },
                type: 0,
              },
            }),
          );
        }
        if (frame.op === 6) {
          ws.send(JSON.stringify({ op: 0, s: 3, t: "RESUMED", d: {} }));
        }
      });
    });
    active = await setup(undefined, remote.url, undefined, db);
    await active.plugin.start?.(new AbortController().signal);
    await expect
      .poll(
        async () =>
          (await db.getState({ pluginId: "channel-discord", ownerId: "dc" }, "gateway-session"))
            ?.value,
      )
      .toMatchObject({ session_id: "durable-session", seq: 2 });
    await active.plugin.stop?.();
    await db.close();
    db = createSqliteStorage({ filename, busyTimeoutMs: 5000 });
    active = await setup(undefined, remote.url, undefined, db);
    await active.plugin.start?.(new AbortController().signal);
    await expect.poll(() => frames.some((frame) => frame.op === 6)).toBe(true);
    expect(frames).toContainEqual({
      op: 6,
      d: { token: "discord-token", session_id: "durable-session", seq: 2 },
    });
    await expect.poll(() => active?.connections.includes("connected")).toBe(true);
  });

  it("does not advance resume cursor when ingestion fails", async () => {
    const remote = await gateway();
    let attempts = 0;
    const test = await setup(undefined, remote.url, async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("commit failed");
      }
    });
    cleanup.unshift(async () => {
      await test.plugin.stop?.();
    });
    const frames: Record<string, unknown>[] = [];
    remote.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      ws.on("message", (raw) => {
        const frame = readFrame(raw);
        frames.push(frame);
        if (frame.op === 1) {
          ws.send(JSON.stringify({ op: 11 }));
        }
        if (frame.op === 2) {
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "failed-session",
                resume_gateway_url: remote.url,
                user: { id: "999" },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 2,
              t: "MESSAGE_CREATE",
              d: {
                id: "789",
                channel_id: "456",
                content: "hello",
                author: { id: "42" },
                type: 0,
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 3,
              t: "MESSAGE_CREATE",
              d: {
                id: "790",
                channel_id: "456",
                content: "later event",
                author: { id: "42" },
                type: 0,
              },
            }),
          );
        }
      });
    });
    await test.plugin.start?.(new AbortController().signal);
    await expect.poll(() => frames.some((frame) => frame.op === 6)).toBe(true);
    expect(frames).toContainEqual({
      op: 6,
      d: { token: "discord-token", session_id: "failed-session", seq: 1 },
    });
    expect(test.received).toHaveLength(0);
    expect(attempts).toBe(1);
  });

  it("resolves guild thread parent for binding and sends to the frozen thread channel", async () => {
    const remoteGateway = await gateway();
    const remoteApi = await peer((input) => ({
      body:
        input.path === "/channels/456" ? { id: "456", type: 11, parent_id: "123" } : { id: "900" },
    }));
    const test = await setup(remoteApi.url, remoteGateway.url);
    cleanup.unshift(async () => {
      await test.plugin.stop?.();
      await remoteApi.close();
    });
    remoteGateway.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      ws.on("message", (raw) => {
        const frame = readFrame(raw);
        if (frame.op === 1) {
          ws.send(JSON.stringify({ op: 11 }));
        }
        if (frame.op === 2) {
          ws.send(
            JSON.stringify({
              op: 0,
              s: 1,
              t: "READY",
              d: {
                session_id: "thread-session",
                resume_gateway_url: remoteGateway.url,
                user: { id: "999" },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              op: 0,
              s: 2,
              t: "MESSAGE_CREATE",
              d: {
                id: "789",
                channel_id: "456",
                guild_id: "777",
                content: "hello",
                author: { id: "42" },
                type: 0,
              },
            }),
          );
        }
      });
    });
    await test.plugin.start?.(new AbortController().signal);
    await expect.poll(() => test.received.length).toBe(1);
    const threadTarget = { ...target, chatId: "123", threadId: "456" };
    expect(test.received[0]).toMatchObject({ target: threadTarget, context: { guildId: "777" } });
    expect(remoteApi.requests[0]).toMatchObject({
      path: "/channels/456",
      headers: { authorization: "Bot discord-token" },
      body: null,
    });
    expect((await test.plugin.send(sendInput(threadTarget))).status).toBe("sent");
    expect(remoteApi.requests[1]?.path).toBe("/channels/456/messages");
  });

  it("reconnects on missing heartbeat ACK and stops on invalid bot identity", async () => {
    const remote = await gateway();
    const test = await setup(undefined, remote.url);
    cleanup.unshift(async () => {
      await test.plugin.stop?.();
    });
    let connected = 0;
    remote.wss.on("connection", (ws) => {
      connected++;
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }));
    });
    await test.plugin.start?.(new AbortController().signal);
    await expect.poll(() => connected).toBeGreaterThanOrEqual(2);
    await test.plugin.stop?.();
    const bad = await setup(undefined, remote.url);
    cleanup.unshift(async () => {
      await bad.plugin.stop?.();
    });
    remote.wss.removeAllListeners("connection");
    remote.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      ws.send(
        JSON.stringify({
          op: 0,
          s: 1,
          t: "READY",
          d: {
            session_id: "wrong",
            resume_gateway_url: remote.url,
            user: { id: "other-bot" },
          },
        }),
      );
    });
    await bad.plugin.start?.(new AbortController().signal);
    await expect.poll(() => bad.connections.includes("degraded")).toBe(true);
    expect(bad.received).toHaveLength(0);
  });

  it("sends to frozen channel/thread ID without mentions and uses bounded nonce dedup", async () => {
    const remote = await peer(() => ({ body: { id: "900" } }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual({
      status: "sent",
      receipt: { platformMessageId: "900" },
    });
    expect(remote.requests[0]).toMatchObject({
      path: "/channels/456/messages",
      headers: { authorization: "Bot discord-token" },
      body: {
        content: "hello @everyone <@U123>",
        allowed_mentions: { parse: [], replied_user: false },
        enforce_nonce: true,
        message_reference: { message_id: "789", fail_if_not_exists: false },
      },
    });
    expect((remote.requests[0]?.body as { nonce?: string } | undefined)?.nonce).toMatch(
      /^[a-f0-9]{24}$/u,
    );
    expect(test.plugin.capabilities.idempotentSend).toBe(false);
  });

  it.each([
    {
      status: 429,
      body: { retry_after: 1.25, global: false },
      expected: {
        status: "retryable",
        errorCode: "rate_limited",
        retryAfterMs: 1250,
      },
    },
    {
      status: 403,
      body: { message: "sensitive", code: 50_013 },
      expected: { status: "rejected", errorCode: "platform_http_error" },
    },
    {
      status: 500,
      body: {},
      expected: { status: "unknown", errorCode: "platform_http_error" },
    },
  ])("maps actual REST errors", async ({ status, body, expected }) => {
    const remote = await peer(() => ({ status, body }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual(expected);
  });

  it("rejects credential/intents/TLS config and account target mismatches", async () => {
    const plugin = createDiscordChannel(environment);
    expect(() => plugin.validateConfig({ botToken: "raw", botUserId: "999" })).toThrow();
    expect(() =>
      plugin.validateConfig({
        botToken: { env: "BOT" },
        botUserId: "999",
        intents: 0,
      }),
    ).toThrow();
    expect(() =>
      plugin.validateConfig({
        botToken: { env: "BOT" },
        botUserId: "999",
        gatewayUrl: "ws://remote.example",
      }),
    ).toThrow();
    const test = await setup();
    expect(await test.plugin.send(sendInput({ ...target, accountId: "foreign" }))).toEqual({
      status: "rejected",
      errorCode: "invalid_target",
    });
  });
});
