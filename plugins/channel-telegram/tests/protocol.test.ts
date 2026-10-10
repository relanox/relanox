import { afterEach, describe, expect, it } from "vitest";
import { createTelegramChannel } from "../src/index.js";
import { peer, recorder, sendInput } from "./peer.js";

const environment = { TOKEN: "123:abc_DEF", SECRET: "webhook-secret" };
const account = {
  id: "tg",
  channel: "telegram" as const,
  config: null,
  allowedSenders: ["42"],
};
const target = {
  channel: "telegram" as const,
  accountId: "tg",
  chatId: "-1007",
  threadId: "8",
  replyToId: "9",
  data: null,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});
async function setup(
  apiBaseUrl = "https://api.telegram.org",
  onIngest?: Parameters<typeof recorder>[0],
) {
  const plugin = createTelegramChannel(environment);
  const recorded = recorder(onIngest);
  await plugin.setup(
    recorded.host,
    account,
    plugin.validateConfig({
      botToken: { env: "TOKEN" },
      webhookSecret: { env: "SECRET" },
      apiBaseUrl,
      allowInsecureLoopback: true,
    }),
  );
  return {
    plugin,
    ...recorded,
    handler: recorded.handlers.get("/webhook") as NonNullable<
      ReturnType<typeof recorded.handlers.get>
    >,
  };
}
function webhook(secret = "webhook-secret", extra: Record<string, unknown> = {}) {
  return new Request("https://relay.example/channels/tg/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({
      update_id: 700,
      message: {
        message_id: 9,
        message_thread_id: 8,
        from: { id: 42, is_bot: false },
        chat: { id: -1007, type: "supergroup" },
        text: "hello",
        ...extra,
      },
    }),
  });
}
describe("telegram native protocol", () => {
  it("bounds authenticated payloads and preserves canceled-send uncertainty", async () => {
    const remote = await peer(() => ({ body: { ok: true, result: { message_id: 100 } } }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    const oversized = new Request("https://relay.example/channels/tg/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: "x".repeat(1_048_577),
    });
    expect((await test.handler(oversized)).status).toBe(413);
    expect(test.received).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(await test.plugin.send(sendInput(target, controller.signal))).toEqual({
      status: "unknown",
      errorCode: "telegram_transport_error",
    });
    expect(remote.requests).toEqual([]);
  });

  it("rejects missing/forged secret and delivers authenticated topic/reply identity", async () => {
    const test = await setup();
    expect((await test.handler(webhook("wrong"))).status).toBe(401);
    expect(test.received).toEqual([]);
    expect((await test.handler(webhook())).status).toBe(204);
    expect(test.received[0]).toMatchObject({
      source: { channel: "telegram", accountId: "tg", eventId: "700" },
      senderId: "42",
      text: "hello",
      target,
      context: { messageId: "9" },
    });
  });

  it("holds ACK until handoff finishes and returns failure when ingest fails", async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const test = await setup(undefined, async () => gate);
    let acknowledged = false;
    const pending = test.handler(webhook()).then((response) => {
      acknowledged = true;
      return response;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(acknowledged).toBe(false);
    finish?.();
    expect((await pending).status).toBe(204);
    const failing = await setup(undefined, async () => {
      throw new Error("storage unavailable");
    });
    expect((await failing.handler(webhook())).status).toBe(503);
  });

  it("filters bot/nontext input and rejects malformed protocol bodies", async () => {
    const test = await setup();
    expect(
      (await test.handler(webhook("webhook-secret", { from: { id: 4, is_bot: true } }))).status,
    ).toBe(204);
    expect((await test.handler(webhook("webhook-secret", { text: undefined }))).status).toBe(204);
    expect(test.received).toHaveLength(0);
    expect(
      (
        await test.handler(
          new Request("https://relay.example/channels/tg/webhook", {
            method: "POST",
            headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("sends plain text independently with durable topic/reply target", async () => {
    const remote = await peer(() => ({
      body: { ok: true, result: { message_id: 100 } },
    }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual({
      status: "sent",
      receipt: { platformMessageId: "100" },
    });
    expect(remote.requests[0]).toMatchObject({
      path: "/bot123:abc_DEF/sendMessage",
      body: {
        chat_id: "-1007",
        text: "hello @everyone <@U123>",
        message_thread_id: 8,
        reply_parameters: { message_id: 9, allow_sending_without_reply: true },
        link_preview_options: { is_disabled: true },
      },
    });
    expect(Object.keys(remote.requests[0]?.body as object).toSorted()).toEqual([
      "chat_id",
      "link_preview_options",
      "message_thread_id",
      "reply_parameters",
      "text",
    ]);
  });

  it.each([
    {
      body: { ok: false, error_code: 429, parameters: { retry_after: 7 } },
      result: {
        status: "retryable",
        errorCode: "rate_limited",
        retryAfterMs: 7000,
      },
    },
    {
      body: {
        ok: false,
        error_code: 403,
        description: "secret sensitive raw error",
      },
      result: { status: "rejected", errorCode: "telegram_api_error" },
    },
    {
      body: { ok: true },
      result: { status: "unknown", errorCode: "invalid_platform_response" },
    },
  ])("maps Bot API outcome without leaking response fields", async ({ body, result }) => {
    const remote = await peer(() => ({ body }));
    cleanup.push(remote.close);
    const test = await setup(remote.url);
    expect(await test.plugin.send(sendInput(target))).toEqual(result);
  });

  it("validates env references, secure URLs and target/account scope", async () => {
    const plugin = createTelegramChannel(environment);
    expect(() =>
      plugin.validateConfig({
        botToken: "secret",
        webhookSecret: { env: "SECRET" },
      }),
    ).toThrow();
    expect(() =>
      plugin.validateConfig({
        botToken: { env: "TOKEN" },
        webhookSecret: { env: "SECRET" },
        apiBaseUrl: "http://remote.example",
      }),
    ).toThrow();
    const test = await setup();
    expect(await test.plugin.send(sendInput({ ...target, accountId: "other" }))).toEqual({
      status: "rejected",
      errorCode: "invalid_target",
    });
  });
});
