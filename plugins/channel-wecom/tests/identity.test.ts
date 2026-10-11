import type { ChannelPlugin, Json, SendInput } from "@relanox/sdk";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createDingTalkChannel } from "../../channel-dingtalk/src/index.js";
import { createQqChannel } from "../../channel-qq/src/index.js";
import { createWeComChannel } from "../src/index.js";
import { wireText } from "../src/transport.js";
import { assemble, peer, records, temporaryDatabase } from "./test-support.js";

type Kind = "wecom" | "dingtalk" | "qq";
function pluginFor(kind: Kind): ChannelPlugin<unknown> {
  switch (kind) {
    case "wecom": {
      return createWeComChannel();
    }
    case "dingtalk": {
      return createDingTalkChannel();
    }
    case "qq": {
      return createQqChannel();
    }
    default: {
      throw new Error("unsupported_channel");
    }
  }
}
async function nativePeer(kind: Kind) {
  let address = "";
  const remote = await peer(
    (request) => {
      if (request.path === "/v1.0/gateway/connections/open") {
        return { body: { endpoint: address, ticket: "ticket" } };
      }
      if (request.path === "/gateway") {
        return { body: { url: address } };
      }
      if (request.path === "/app/getAppAccessToken") {
        return { body: { access_token: "token", expires_in: 7200 } };
      }
      if (request.path === "/v1.0/oauth2/accessToken") {
        return { body: { accessToken: "token", expireIn: 7200 } };
      }
      return { body: { id: "sent", processQueryKey: "sent" } };
    },
    (socket) => {
      if (kind === "qq") {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      }
      socket.on("message", (bytes) => {
        const frame = z
          .object({ op: z.number().optional(), headers: z.unknown().optional() })
          .parse(JSON.parse(wireText(bytes)));
        if (kind === "wecom") {
          socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
        }
        if (frame.op === 2) {
          socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "session" } }));
        }
        if (frame.op === 1) {
          socket.send(JSON.stringify({ op: 11 }));
        }
      });
    },
  );
  address = remote.ws;
  return remote;
}
function configFor(
  kind: Kind,
  remote: Awaited<ReturnType<typeof nativePeer>>,
  changed = false,
): Record<string, Json> {
  const identity = changed ? "replacement" : "original";
  const secret = { env: "ENTERPRISE_SECRET" };
  switch (kind) {
    case "wecom": {
      return { botId: identity, secret, wsUrl: remote.ws, allowInsecureLoopback: true };
    }
    case "dingtalk": {
      return {
        clientId: "client",
        robotCode: identity,
        clientSecret: secret,
        apiBase: remote.http,
        allowInsecureLoopback: true,
      };
    }
    case "qq": {
      return {
        appId: identity,
        clientSecret: secret,
        apiBase: remote.http,
        allowInsecureLoopback: true,
      };
    }
    default: {
      throw new Error("unsupported_channel");
    }
  }
}
function incoming(kind: Kind): unknown {
  switch (kind) {
    case "wecom": {
      return {
        cmd: "aibot_msg_callback",
        headers: { req_id: "delivery" },
        body: {
          msgid: "message",
          aibotid: "original",
          chattype: "single",
          from: { userid: "user" },
          msgtype: "text",
          text: { content: "question" },
        },
      };
    }
    case "dingtalk": {
      return {
        type: "CALLBACK",
        headers: { topic: "/v1.0/im/bot/messages/get", messageId: "delivery" },
        data: JSON.stringify({
          msgId: "message",
          conversationType: "1",
          conversationId: "conversation",
          senderId: "user",
          senderStaffId: "user",
          robotCode: "original",
          msgtype: "text",
          text: { content: "question" },
        }),
      };
    }
    case "qq": {
      return {
        op: 0,
        s: 2,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "message",
          content: "question",
          timestamp: new Date().toISOString(),
          author: { user_openid: "user" },
        },
      };
    }
    default: {
      throw new Error("unsupported_channel");
    }
  }
}
function sentCount(remote: Awaited<ReturnType<typeof nativePeer>>): number {
  return (
    remote.requests.filter(
      (entry) => entry.path.endsWith("/messages") || entry.path.includes("Messages/"),
    ).length +
    remote.frames.filter(
      (entry) => z.object({ cmd: z.literal("aibot_send_msg") }).safeParse(entry).success,
    ).length
  );
}

test.each([
  ["wecom", "identity"],
  ["wecom", "server"],
  ["dingtalk", "identity"],
  ["dingtalk", "server"],
  ["qq", "identity"],
  ["qq", "server"],
] as const)(
  "%s refuses an accepted target after %s changes while allowing secret rotation",
  async (kind, change) => {
    vi.stubEnv("ENTERPRISE_SECRET", "first-secret");
    const original = await nativePeer(kind);
    const replacement = await nativePeer(kind);
    const filename = await temporaryDatabase();
    const bindings = [{ chatId: "user", senderId: "user" }];
    const first = pluginFor(kind);
    const firstHost = await assemble(first, configFor(kind, original), bindings, filename);
    await firstHost.start();
    await expect
      .poll(async () => (await firstHost.runtime.status()).connections["channels/bot"])
      .toBe("connected");
    original.sockets[0]?.send(JSON.stringify(incoming(kind)));
    await expect.poll(async () => (await records(firstHost.storage)).length).toBe(1);
    await first.stop?.();
    await firstHost.storage.close();
    const changed = pluginFor(kind);
    const nextRemote = change === "server" ? replacement : original;
    const nextHost = await assemble(
      changed,
      configFor(kind, nextRemote, change === "identity"),
      bindings,
      filename,
    );
    await nextHost.start();
    await expect
      .poll(async () => (await nextHost.runtime.status()).connections["channels/bot"])
      .toBe("connected");
    const persisted = (await records(nextHost.storage))[0];
    if (!persisted) {
      throw new Error("Missing accepted target after reopen");
    }
    const input: SendInput = {
      deliveryId: "delivery",
      requestId: persisted.snapshot.requestId,
      chunkIndex: 0,
      signal: new AbortController().signal,
      target: persisted.snapshot.target,
      chunk: { text: "answer", idempotencyKey: "delivery:0", state: null },
    };
    expect(await changed.send(input)).toMatchObject({ status: "rejected" });
    expect(sentCount(original) + sentCount(replacement)).toBe(0);
    await changed.stop?.();
    await nextHost.storage.close();
    vi.stubEnv("ENTERPRISE_SECRET", "rotated-secret");
    const restored = pluginFor(kind);
    const restoredHost = await assemble(restored, configFor(kind, original), bindings, filename);
    await restoredHost.start();
    await expect
      .poll(async () => (await restoredHost.runtime.status()).connections["channels/bot"])
      .toBe("connected");
    const legacy = z.record(z.string(), z.json()).parse(input.target.data);
    delete legacy.scope;
    expect(
      await restored.send({ ...input, target: { ...input.target, data: legacy } }),
    ).toMatchObject({ status: "rejected" });
    expect(await restored.send(input)).toMatchObject({ status: "sent" });
    expect(sentCount(original)).toBe(1);
  },
);
