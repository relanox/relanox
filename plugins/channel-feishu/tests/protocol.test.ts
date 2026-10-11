import { createCipheriv, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFeishuChannel } from "../src/index.js";
import { peer, recorder, sendInput } from "./peer.js";

const environment = {
  APPSECRET: "app-secret",
  ENCRYPT: "encrypt-key",
  VERIFY: "verification-token",
};
const account = {
  id: "fs",
  channel: "feishu" as const,
  config: null,
  allowedSenders: ["ou_user"],
};
const target = {
  channel: "feishu" as const,
  accountId: "fs",
  chatId: "oc_chat",
  threadId: "omt_thread",
  replyToId: "om_message",
  data: { tenantKey: "tenant-1" },
};
const event = {
  schema: "2.0",
  header: {
    event_id: "event-42",
    event_type: "im.message.receive_v1",
    app_id: "cli_app",
    tenant_key: "tenant-1",
    token: "verification-token",
  },
  event: {
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_user" },
      tenant_key: "tenant-1",
    },
    message: {
      message_id: "om_message",
      chat_id: "oc_chat",
      chat_type: "group",
      message_type: "text",
      content: '{"text":"hello"}',
      create_time: "1700000000000",
      thread_id: "omt_thread",
    },
  },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
async function setup(
  apiBaseUrl = "https://open.feishu.cn",
  onIngest?: Parameters<typeof recorder>[0],
) {
  const plugin = createFeishuChannel(environment);
  const recorded = recorder(onIngest);
  await plugin.setup(
    recorded.host,
    account,
    plugin.validateConfig({
      appId: "cli_app",
      appSecret: { env: "APPSECRET" },
      encryptKey: { env: "ENCRYPT" },
      verificationToken: { env: "VERIFY" },
      tenantKey: "tenant-1",
      botOpenId: "ou_bot",
      apiBaseUrl,
      allowInsecureLoopback: true,
    }),
  );
  return {
    plugin,
    ...recorded,
    handler: recorded.handlers.get("/events") as NonNullable<
      ReturnType<typeof recorded.handlers.get>
    >,
  };
}
function request(
  value: unknown,
  encrypted = false,
  forged = false,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  let body = JSON.stringify(value);
  if (encrypted) {
    const iv = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const cipher = createCipheriv(
      "aes-256-cbc",
      createHash("sha256").update("encrypt-key").digest(),
      iv,
    );
    body = JSON.stringify({
      encrypt: Buffer.concat([iv, cipher.update(body, "utf8"), cipher.final()]).toString("base64"),
    });
  }
  const signature = createHash("sha256")
    .update(`${timestamp}nonce-1encrypt-key${body}`)
    .digest("hex");
  return new Request("https://relay.example/channels/fs/events", {
    method: "POST",
    body,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": "nonce-1",
      "x-lark-signature": forged ? "bad-signature" : signature,
    },
  });
}
describe("feishu native HTTP protocol", () => {
  it.each(["sender_not_allowed", "unbound_conversation"])(
    "acknowledges terminal core policy rejection: %s",
    async (code) => {
      const test = await setup(undefined, async () => {
        throw Object.assign(new Error(code), { code });
      });
      expect((await test.handler(request(event))).status).toBe(204);
      expect(test.received).toEqual([]);
    },
  );

  it("bounds event bodies and keeps canceled token acquisition retryable", async () => {
    const remote = await peer(() => ({
      body: { code: 0, tenant_access_token: "tenant-token", expire: 7200 },
    }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    const oversized = new Request("https://relay.example/channels/fs/events", {
      method: "POST",
      headers: {
        "x-lark-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-lark-request-nonce": "nonce-1",
      },
      body: "x".repeat(1_048_577),
    });
    expect((await test.handler(oversized)).status).toBe(413);
    expect(test.received).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(await test.plugin.send(sendInput(target, controller.signal))).toEqual({
      status: "retryable",
      errorCode: "tenant_token_transport_error",
    });
    expect(remote.requests).toEqual([]);
  });

  it("authenticates raw signature, freshness and encrypted URL challenge", async () => {
    const test = await setup();
    expect((await test.handler(request(event, false, true))).status).toBe(401);
    expect((await test.handler(request(event, false, false, "1000000000"))).status).toBe(401);
    expect(
      await (
        await test.handler(
          request(
            {
              type: "url_verification",
              token: "verification-token",
              challenge: "challenge-1",
            },
            true,
          ),
        )
      ).json(),
    ).toEqual({ challenge: "challenge-1" });
    expect(
      (
        await test.handler(
          request(
            {
              type: "url_verification",
              token: "wrong-token",
              challenge: "challenge-1",
            },
            true,
          ),
        )
      ).status,
    ).toBe(401);
    expect(test.received).toHaveLength(0);
  });

  it.each([false, true])(
    "normalizes signed event text/tenant/thread (encrypted=%s)",
    async (encrypted) => {
      const test = await setup();
      expect((await test.handler(request(event, encrypted))).status).toBe(204);
      expect(test.received[0]).toMatchObject({
        source: { channel: "feishu", accountId: "fs", eventId: "event-42" },
        senderId: "ou_user",
        text: "hello",
        target,
        context: { tenantKey: "tenant-1" },
      });
    },
  );

  it("rejects foreign app/tenant/token and corrupted signed ciphertext", async () => {
    const test = await setup();
    for (const header of [
      { ...event.header, tenant_key: "tenant-2" },
      { ...event.header, app_id: "cli_other" },
      { ...event.header, token: "wrong-token" },
    ]) {
      expect((await test.handler(request({ ...event, header }))).status).toBe(401);
    }
    expect((await test.handler(request({ encrypt: "AAAAAAAAAAAAAAAAAAAAAA==" }))).status).toBe(400);
    expect(test.received).toHaveLength(0);
  });

  it("diagnoses unsupported media/bot events and never ACKs failed ingest", async () => {
    const test = await setup();
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: {
              ...event.event,
              message: { ...event.event.message, message_type: "image" },
            },
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await test.handler(
          request({
            ...event,
            event: {
              ...event.event,
              sender: { ...event.event.sender, sender_type: "app" },
            },
          }),
        )
      ).status,
    ).toBe(204);
    expect(test.received).toHaveLength(0);
    const failing = await setup(undefined, async () => {
      throw new Error("db unavailable");
    });
    expect((await failing.handler(request(event))).status).toBe(503);
  });

  it.each([
    { status: 503, body: {}, expected: "retryable" },
    { status: 200, body: {}, expected: "retryable" },
    { status: 403, body: {}, expected: "rejected" },
  ])(
    "does not freeze unsent text after token endpoint HTTP $status",
    async ({ status, body, expected }) => {
      const remote = await peer(() => ({ status, body }));
      cleanup.push(remote.close);
      const test = await setup(remote.url);
      expect((await test.plugin.send(sendInput(target))).status).toBe(expected);
      expect(remote.requests.map((input) => input.path)).toEqual([
        "/open-apis/auth/v3/tenant_access_token/internal",
      ]);
    },
  );

  it("refreshes expiring tenant tokens and uses independent nested text reply wire", async () => {
    let tokens = 0;
    const remote = await peer((input) =>
      input.path.includes("tenant_access_token")
        ? {
            body: {
              code: 0,
              tenant_access_token: `tenant-token-${++tokens}`,
              expire: 30,
            },
          }
        : { body: { code: 0, data: { message_id: "om_sent" } } },
    );
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual({
      status: "sent",
      receipt: { platformMessageId: "om_sent" },
    });
    expect(remote.requests[0]).toMatchObject({
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      body: { app_id: "cli_app", app_secret: "app-secret" },
    });
    expect(remote.requests[1]).toMatchObject({
      path: "/open-apis/im/v1/messages/om_message/reply",
      headers: { authorization: "Bearer tenant-token-1" },
      body: {
        msg_type: "text",
        content: '{"text":"hello @everyone <@U123>"}',
        reply_in_thread: true,
      },
    });
    await test.plugin.send(sendInput(target));
    expect(tokens).toBe(2);
  });

  it("uses chat-id create path when there is no referenced source message", async () => {
    const remote = await peer((input) => ({
      body: input.path.includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "tenant-token", expire: 7200 }
        : { code: 0, data: { message_id: "om_sent" } },
    }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    const { replyToId: _reply, threadId: _thread, ...chatTarget } = target;
    expect((await test.plugin.send(sendInput(chatTarget))).status).toBe("sent");
    expect(remote.requests[1]).toMatchObject({
      path: "/open-apis/im/v1/messages?receive_id_type=chat_id",
      body: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: '{"text":"hello @everyone <@U123>"}',
      },
    });
  });

  it.each([
    {
      status: 429,
      body: { code: 99_991_400 },
      expected: {
        status: "retryable",
        errorCode: "rate_limited",
        retryAfterMs: 2000,
      },
    },
    {
      status: 200,
      body: { code: 230_001, msg: "raw secret details" },
      expected: { status: "rejected", errorCode: "feishu_api_error" },
    },
    {
      status: 200,
      body: { code: 0 },
      expected: { status: "unknown", errorCode: "invalid_platform_response" },
    },
  ])("maps message API errors without raw fields", async ({ status, body, expected }) => {
    const remote = await peer((input) =>
      input.path.includes("tenant_access_token")
        ? {
            body: {
              code: 0,
              tenant_access_token: "tenant-token",
              expire: 7200,
            },
          }
        : { status, headers: { "retry-after": "2" }, body },
    );
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual(expected);
  });

  it("rejects literal credentials, insecure remote URL and foreign tenant targets", async () => {
    const plugin = createFeishuChannel(environment);
    expect(() => plugin.validateConfig({ appId: "cli_app", appSecret: "raw" })).toThrow();
    const config = {
      appId: "cli_app",
      appSecret: { env: "APPSECRET" },
      encryptKey: { env: "ENCRYPT" },
      verificationToken: { env: "VERIFY" },
      tenantKey: "tenant-1",
      botOpenId: "ou_bot",
    };
    expect(() =>
      plugin.validateConfig({ ...config, apiBaseUrl: "http://remote.example" }),
    ).toThrow();
    expect(plugin.validateConfig({ ...config, domain: "lark" }).domain).toBe("lark");
    const test = await setup();
    expect(
      await test.plugin.send(sendInput({ ...target, data: { tenantKey: "tenant-2" } })),
    ).toEqual({ status: "rejected", errorCode: "invalid_target" });
  });
});
