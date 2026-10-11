import { wireText } from "../../channel-wecom/src/transport.js";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createWeComChannel } from "../src/index.js";
import { assemble, peer, records, sendInput } from "./test-support.js";

test("WeCom subscribes, deduplicates body IDs, keeps durable targets and sends independent escaped Markdown", async () => {
  vi.stubEnv("WECOM_SECRET", "private-value");
  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on("message", (data) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() }),
          })
          .parse(JSON.parse(wireText(data)));
        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
      });
    },
  );
  const plugin = createWeComChannel();
  const host = await assemble(
    plugin,
    {
      botId: "robot",
      secret: { env: "WECOM_SECRET" },
      wsUrl: remote.ws,
      allowInsecureLoopback: true,
    },
    [
      { chatId: "user", senderId: "user" },
      { chatId: "group", senderId: "user" },
    ],
  );
  await host.start();
  expect(remote.frames[0]).toMatchObject({
    cmd: "aibot_subscribe",
    body: { bot_id: "robot", secret: "private-value" },
  });
  const socket = remote.sockets[0];
  if (!socket) {
    throw new Error("Peer not connected");
  }
  const body = {
    msgid: "stable-1",
    aibotid: "robot",
    chattype: "single",
    from: { userid: "user" },
    msgtype: "text",
    text: { content: "question" },
    response_url: "https://secret.invalid/token",
  };
  socket.send(
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "callback-1" },
      body,
    }),
  );
  socket.send(
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "callback-2" },
      body,
    }),
  );
  socket.send(
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "callback-3" },
      body: {
        ...body,
        msgid: "stable-group",
        chattype: "group",
        chatid: "group",
      },
    }),
  );
  socket.send(
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "wrong-bot" },
      body: { ...body, aibotid: "other", msgid: "wrong" },
    }),
  );
  socket.send(
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: "media" },
      body: { ...body, msgid: "media", msgtype: "image" },
    }),
  );
  await expect.poll(async () => (await records(host.storage)).length).toBe(2);
  const accepted = await records(host.storage);
  expect(accepted.map((item) => item.snapshot.source.eventId).toSorted()).toEqual([
    "stable-1",
    "stable-group",
  ]);
  expect(accepted.map((item) => item.snapshot.target.chatId).toSorted()).toEqual(["group", "user"]);
  expect(JSON.stringify(accepted)).not.toContain("secret.invalid");
  const result = await plugin.send(
    sendInput("wecom", "group", {
      chattype: "group",
      scope: { botId: "robot", wsUrl: new URL(remote.ws).href },
    }),
  );
  expect(result).toEqual({ status: "sent", receipt: {} });
  expect(remote.frames.at(-1)).toMatchObject({
    cmd: "aibot_send_msg",
    body: {
      chatid: "group",
      msgtype: "markdown",
      markdown: { content: "hello\\_\\*世界" },
    },
  });
  expect(JSON.stringify(remote.frames.at(-1))).not.toContain("chat_type");
});

test("WeCom correlates heartbeats and preserves uncertain sends when the socket closes before ACK", async () => {
  vi.stubEnv("WECOM_SECRET", "secret");
  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on("message", (data) => {
        const frame = z
          .object({
            cmd: z.string(),
            headers: z.object({ req_id: z.string() }),
          })
          .parse(JSON.parse(wireText(data)));
        if (frame.cmd === "aibot_send_msg") {
          socket.send(JSON.stringify({ headers: { req_id: "unrelated" }, errcode: 0 }));
          socket.close();
        } else {
          socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
        }
      });
    },
  );
  const plugin = createWeComChannel();
  const host = await assemble(
    plugin,
    {
      botId: "robot",
      secret: { env: "WECOM_SECRET" },
      wsUrl: remote.ws,
      heartbeatMs: 1000,
      allowInsecureLoopback: true,
    },
    [{ chatId: "user", senderId: "user" }],
  );
  await host.start();
  await expect
    .poll(
      () =>
        remote.frames.some(
          (frame) => z.object({ cmd: z.literal("ping") }).safeParse(frame).success,
        ),
      { timeout: 3000 },
    )
    .toBe(true);
  expect(
    await plugin.send(
      sendInput("wecom", "user", {
        chattype: "single",
        scope: { botId: "robot", wsUrl: new URL(remote.ws).href },
      }),
    ),
  ).toEqual({
    status: "unknown",
    errorCode: "transport_uncertain",
  });
  host.controller.abort();
  await new Promise((resolve) => {
    setTimeout(resolve, 1200);
  });
  expect(remote.sockets).toHaveLength(1);
  expect(plugin.capabilities.idempotentSend).toBe(false);
});

test("WeCom rejects raw secrets and insecure nonlocal endpoints", () => {
  const plugin = createWeComChannel();
  expect(() => plugin.validateConfig({ botId: "robot", secret: "raw" })).toThrow();
  expect(() =>
    plugin.validateConfig({
      botId: "robot",
      secret: { env: "SECRET" },
      wsUrl: "ws://remote.example",
      allowInsecureLoopback: true,
    }),
  ).toThrow();
});

test("WeCom stops recovery after the platform replaces this bot connection", async () => {
  vi.stubEnv("WECOM_SECRET", "secret");
  const remote = await peer(
    () => ({ status: 404 }),
    (socket) => {
      socket.on("message", (data) => {
        const frame = z
          .object({ headers: z.object({ req_id: z.string() }) })
          .parse(JSON.parse(wireText(data)));
        socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
      });
    },
  );
  const plugin = createWeComChannel();
  const host = await assemble(
    plugin,
    {
      botId: "robot",
      secret: { env: "WECOM_SECRET" },
      wsUrl: remote.ws,
      allowInsecureLoopback: true,
    },
    [{ chatId: "user", senderId: "user" }],
  );
  await host.start();
  const socket = remote.sockets[0];
  if (!socket) {
    throw new Error("Peer not connected");
  }
  socket.send(
    JSON.stringify({
      cmd: "aibot_event_callback",
      headers: { req_id: "replaced" },
      body: { aibotid: "robot", event: { eventtype: "disconnected_event" } },
    }),
  );
  await expect
    .poll(async () => (await host.runtime.status()).connections["channels/bot"])
    .toBe("degraded");
  await new Promise((resolve) => {
    setTimeout(resolve, 1200);
  });
  expect(remote.sockets).toHaveLength(1);
  expect(
    await plugin.send(
      sendInput("wecom", "user", {
        chattype: "single",
        scope: { botId: "robot", wsUrl: new URL(remote.ws).href },
      }),
    ),
  ).toMatchObject({
    status: "retryable",
    errorCode: "not_connected",
  });
});

test.each(["missing credential", "rejected subscription"])(
  "WeCom closes an unauthenticated socket after %s",
  async (scenario) => {
    vi.stubEnv("WECOM_SECRET", scenario === "missing credential" ? "" : "secret");
    const remote = await peer(
      () => ({ status: 404 }),
      (socket) => {
        socket.on("message", (data) => {
          const frame = z
            .object({ headers: z.object({ req_id: z.string() }) })
            .parse(JSON.parse(wireText(data)));
          socket.send(JSON.stringify({ headers: frame.headers, errcode: 40_001 }));
        });
      },
    );
    const plugin = createWeComChannel();
    const host = await assemble(
      plugin,
      {
        botId: "robot",
        secret: { env: "WECOM_SECRET" },
        wsUrl: remote.ws,
        allowInsecureLoopback: true,
        maxReconnectAttempts: 0,
      },
      [{ chatId: "user", senderId: "user" }],
    );
    await host.start();
    await expect.poll(() => remote.sockets[0]?.readyState).toBe(3);
    expect(
      await plugin.send(
        sendInput("wecom", "user", {
          chattype: "single",
          scope: { botId: "robot", wsUrl: new URL(remote.ws).href },
        }),
      ),
    ).toMatchObject({
      status: "retryable",
      errorCode: "not_connected",
    });
    expect(await records(host.storage)).toHaveLength(0);
  },
);
