import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, SendInput } from "@relanox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppChannel } from "../src/index.js";
import { harness, peer } from "./harness.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
  vi.unstubAllEnvs();
});
const config = (base: string): Json => ({
  phoneNumberId: "phone",
  businessAccountId: "business-1",
  appSecret: { env: "WA_SECRET" },
  verifyToken: { env: "WA_VERIFY" },
  accessToken: { env: "WA_TOKEN" },
  apiVersion: "v25.0",
  apiBase: base,
  allowLoopback: true,
});
function webhook(timestamp = Math.floor(Date.now() / 1000), phone = "phone", eventId = "wamid.1") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "business-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phone },
              messages: [
                {
                  id: eventId,
                  from: "customer",
                  timestamp: String(timestamp),
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}
function incoming(body: string, signature?: string) {
  const expected = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  return new Request("http://local/channels/business/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": signature ?? expected },
    body,
  });
}
async function setup(filename = ":memory:") {
  vi.stubEnv("WA_SECRET", "secret");
  vi.stubEnv("WA_VERIFY", "verify");
  vi.stubEnv("WA_TOKEN", "token");
  const remote = await peer();
  cleanup.push(remote.close);
  remote.respond(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.sent" }] });
  const plugin = createWhatsAppChannel();
  const local = await harness(
    plugin,
    config(remote.base),
    "customer",
    "customer",
    undefined,
    filename,
  );
  cleanup.push(local.close);
  return { remote, plugin, ...local };
}

describe("native WhatsApp Cloud", () => {
  it.each(["business", "server", "rotation"] as const)(
    "preserves pending reply identity across restart: %s",
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), "relanox-whatsapp-"));
      cleanup.push(async () => {
        await rm(directory, { recursive: true });
      });
      const filename = join(directory, "state.db");
      const local = await setup(filename);
      expect((await local.core.fetch(incoming(webhook()))).status).toBe(200);
      await local.close();
      cleanup.pop();
      const replacement = await peer();
      cleanup.push(replacement.close);
      replacement.respond(200, {
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.other" }],
      });
      const plugin = createWhatsAppChannel();
      const next = plugin.validateConfig(
        config(change === "server" ? replacement.base : `${local.remote.base}/`),
      );
      if (change === "business") {
        next.businessAccountId = "business-2";
      }
      vi.stubEnv("WA_TOKEN", "rotated-token");
      const restarted = await harness(plugin, next, "customer", "customer", undefined, filename);
      cleanup.push(restarted.close);
      const completed = await restarted.complete();
      expect(completed.delivery?.status).toBe(change === "rotation" ? "sent" : "rejected");
      expect(replacement.traffic).toHaveLength(0);
      expect(local.remote.traffic).toHaveLength(change === "rotation" ? 1 : 0);
      if (change === "rotation") {
        expect(local.remote.traffic[0]?.path).toBe("/v25.0/phone/messages");
        expect(local.remote.traffic[0]?.headers.authorization).toBe("Bearer rotated-token");
      }
    },
  );

  it("does not share customer windows across replacement phone identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relanox-whatsapp-window-"));
    cleanup.push(async () => {
      await rm(directory, { recursive: true });
    });
    const filename = join(directory, "state.db");
    const local = await setup(filename);
    expect(
      (await local.core.fetch(incoming(webhook().replace('"type":"text"', '"type":"image"'))))
        .status,
    ).toBe(200);
    await local.close();
    cleanup.pop();
    const plugin = createWhatsAppChannel();
    const next = plugin.validateConfig(config(local.remote.base));
    next.phoneNumberId = "replacement-phone";
    const restarted = await harness(plugin, next, "customer", "customer", undefined, filename);
    cleanup.push(restarted.close);
    expect(
      (
        await restarted.core.fetch(
          incoming(
            webhook(Math.floor(Date.now() / 1000) - 86_401, "replacement-phone", "wamid.old"),
          ),
        )
      ).status,
    ).toBe(200);
    const completed = await restarted.complete();
    expect(completed.delivery?.status).toBe("rejected");
    expect(completed.delivery?.errorCode).toBe("customer_window_expired");
    expect(local.remote.traffic).toHaveLength(0);
    const delivery = completed.delivery;
    if (!delivery?.chunks[0]) {
      throw new Error("No outbound");
    }
    expect(
      await plugin.send({
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        target: {
          ...delivery.target,
          data: {
            phoneNumberId: "replacement-phone",
            customer: "customer",
            windowUntil: Date.now() + 10_000,
          },
        },
        chunk: delivery.chunks[0],
        chunkIndex: 0,
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "rejected", errorCode: "invalid_target" });
  });

  it("verifies challenge and exact HMAC, deduplicates and independently sends Graph text", async () => {
    const local = await setup();
    const challenge = await local.core.fetch(
      new Request(
        "http://local/channels/business/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345",
      ),
    );
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe("12345");
    expect(
      (
        await local.core.fetch(
          new Request(
            "http://local/channels/business/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
          ),
        )
      ).status,
    ).toBe(403);
    expect((await local.core.fetch(incoming(webhook(), "sha256=bad"))).status).toBe(401);
    expect((await local.core.fetch(incoming("{"))).status).toBe(400);
    expect((await local.core.fetch(incoming(webhook(undefined, "other-phone")))).status).toBe(500);
    const body = `${webhook()}\n`;
    expect((await local.core.fetch(incoming(body))).status).toBe(200);
    expect((await local.core.fetch(incoming(body))).status).toBe(200);
    expect((await local.storage.getStats()).pending).toBe(1);
    const completed = await local.complete();
    expect(completed.delivery?.status).toBe("sent");
    expect(local.dispatches).toEqual(["hello"]);
    const sent = local.remote.traffic[0];
    expect(sent?.path).toBe("/v25.0/phone/messages");
    expect(sent?.headers.authorization).toBe("Bearer token");
    expect(JSON.parse(sent?.body ?? "null") as unknown).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "customer",
      type: "text",
      text: { body: "answer", preview_url: false },
    });
    expect(completed.delivery?.receipts).toEqual([{ platformMessageId: "wamid.sent" }]);
  });

  it("rejects expired customer text and refreshes the durable window on newer non-text customer activity", async () => {
    const local = await setup();
    expect(
      (await local.core.fetch(incoming(webhook(Math.floor(Date.now() / 1000) - 86_401)))).status,
    ).toBe(200);
    const completed = await local.complete();
    expect(completed.delivery?.status).toBe("rejected");
    expect(completed.delivery?.errorCode).toBe("customer_window_expired");
    expect(local.remote.traffic).toHaveLength(0);
    const outbound = completed.delivery;
    if (!outbound?.chunks[0]) {
      throw new Error("No outbound");
    }
    const send: SendInput = {
      deliveryId: outbound.deliveryId,
      requestId: outbound.requestId,
      target: outbound.target,
      chunk: outbound.chunks[0],
      chunkIndex: 0,
      signal: new AbortController().signal,
    };
    expect(
      (
        await local.core.fetch(
          incoming(
            webhook(undefined, "phone", "wamid.2").replace('"type":"text"', '"type":"image"'),
          ),
        )
      ).status,
    ).toBe(200);
    expect(await local.plugin.send(send)).toEqual({
      status: "sent",
      receipt: { platformMessageId: "wamid.sent" },
    });
    expect(local.remote.traffic).toHaveLength(1);
  });

  it.each([
    [429, "pending"],
    [403, "rejected"],
    [503, "unknown"],
  ] as const)("maps provider HTTP %s to %s", async (status, expected) => {
    const local = await setup();
    await local.core.fetch(incoming(webhook()));
    local.remote.respond(status, {}, { "retry-after": "2" });
    expect((await local.complete()).delivery?.status).toBe(expected);
    expect(local.remote.traffic).toHaveLength(1);
  });

  it("requires SecretRefs and explicit loopback permission", () => {
    const plugin = createWhatsAppChannel();
    expect(() =>
      plugin.validateConfig({
        phoneNumberId: "phone",
        businessAccountId: "business-1",
        appSecret: "secret",
        verifyToken: "verify",
        accessToken: "token",
        apiVersion: "v25.0",
      }),
    ).toThrow();
    expect(() =>
      plugin.validateConfig({
        phoneNumberId: "phone",
        businessAccountId: "business-1",
        appSecret: { env: "SECRET" },
        verifyToken: { env: "VERIFY" },
        accessToken: { env: "TOKEN" },
        apiVersion: "v25.0",
        apiBase: "http://127.0.0.1",
      }),
    ).toThrow("unsafe_endpoint");
  });
});
