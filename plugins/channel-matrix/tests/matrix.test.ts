import type { SendInput } from "@relanox/sdk";
import { expect, it } from "vitest";
import { createMatrixChannel } from "../src/index.js";
import { body, harness, httpPeer, json, observations, waitFor } from "./harness.js";

const user = "@alice:local.test";
const room = "!room:local.test";
const thread = "$thread-root";
function config(base: string) {
  return {
    homeserver: base,
    userId: "@bot:local.test",
    accessToken: { env: "MATRIX_TOKEN" },
    allowInsecureLocalhost: true,
    syncTimeoutMs: 0,
    reconnectMs: 100,
  };
}
function event(eventId: string, text: string, sender = user) {
  return {
    event_id: eventId,
    sender,
    type: "m.room.message",
    origin_server_ts: 1_800_000_000_000,
    content: {
      msgtype: "m.text",
      body: text,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: thread,
        "m.in_reply_to": { event_id: "$parent" },
      },
    },
  };
}
function input(target: SendInput["target"], text = "delayed answer"): SendInput {
  return {
    deliveryId: "delivery",
    requestId: "request",
    target,
    chunk: { text, idempotencyKey: "durable-delivery:0", state: null },
    chunkIndex: 0,
    signal: new AbortController().signal,
  };
}

it("persists threaded sync before cursor, filters identities and sends the frozen delayed target", async () => {
  const syncs: { since: string | null; authorization: string | undefined }[] = [];
  const sent: {
    path: string;
    method: string | undefined;
    authorization: string | undefined;
    data: unknown;
  }[] = [];
  const dispatches: unknown[] = [];
  const observation = observations();
  let encrypted = false;
  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://peer");
    if (url.pathname.endsWith("/sync")) {
      syncs.push({
        since: url.searchParams.get("since"),
        authorization: request.headers.authorization,
      });
      const events =
        syncs.length === 1
          ? [
              event("$incoming", "question"),
              event("$incoming", "question"),
              event("$own", "echo", "@bot:local.test"),
              event("$blocked", "blocked", "@mallory:local.test"),
              {
                ...event("$encrypted", "cipher"),
                type: "m.room.encrypted",
                content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "unreadable" },
              },
            ]
          : [];
      json(response, {
        next_batch: "batch-committed",
        rooms: { join: { [room]: { timeline: { events } } } },
      });
      return;
    }
    if (url.pathname.endsWith("/state/m.room.encryption")) {
      json(
        response,
        encrypted ? { algorithm: "m.megolm.v1.aes-sha2" } : { errcode: "M_NOT_FOUND" },
        encrypted ? 200 : 404,
      );
      return;
    }
    if (url.pathname.includes("/send/")) {
      sent.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.authorization,
        data: await body(request),
      });
      json(response, { event_id: "$sent" });
      return;
    }
    dispatches.push(await body(request));
    json(response, {});
  });
  const plugin = createMatrixChannel({ MATRIX_TOKEN: "matrix-access-secret" });
  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe },
  );
  await plugin.start?.(new AbortController().signal);
  await waitFor(
    async () =>
      (await fixture.storage.getState({ pluginId: "channel-matrix", ownerId: "bot" }, "sync"))
        ?.value === "batch-committed",
  );
  await plugin.stop?.();
  const requests = await fixture.storage.listInbound({ limit: 20 });
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) {
    throw new Error("Missing request");
  }
  expect(request.snapshot.target).toEqual({
    channel: "matrix",
    accountId: "bot",
    chatId: room,
    threadId: thread,
    replyToId: "$incoming",
    data: { homeserver: peer.base, userId: "@bot:local.test" },
  });
  expect(request.snapshot.senderId).toBe(user);
  expect(syncs[0]).toEqual({ since: null, authorization: "Bearer matrix-access-secret" });
  expect(
    observation.logs.some((entry) => entry.fields?.errorCode === "encrypted_unsupported"),
  ).toBe(true);
  expect(observation.logs.some((entry) => entry.fields?.errorCode === "sender_not_allowed")).toBe(
    true,
  );
  expect(JSON.stringify(request.snapshot)).not.toContain("matrix-access-secret");
  await fixture.runtime.processDue();
  expect(dispatches).toEqual([{ requestId: request.snapshot.requestId, text: "question" }]);
  const completed = await fixture.complete(request.snapshot.requestId);
  await fixture.runtime.processDue();
  expect((await fixture.storage.getOutbound(completed.deliveryId))?.status).toBe("sent");
  expect(sent[0]?.method).toBe("PUT");
  expect(sent[0]?.authorization).toBe("Bearer matrix-access-secret");
  expect(sent[0]?.path).toContain("/rooms/!room%3Alocal.test/send/m.room.message/");
  expect(sent[0]?.data).toEqual({
    msgtype: "m.text",
    body: "delayed answer",
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: thread,
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$incoming" },
    },
  });
  await plugin.send(input(request.snapshot.target));
  await plugin.send(input(request.snapshot.target));
  expect(sent.at(-1)?.path).toBe(sent.at(-2)?.path);
  encrypted = true;
  expect(await plugin.send(input(request.snapshot.target))).toEqual({
    status: "rejected",
    errorCode: "encrypted_unsupported",
  });
  expect(sent).toHaveLength(3);
  expect(plugin.capabilities.idempotentSend).toBe(false);
});

it("replays from the last committed cursor after a real storage failure and restart", async () => {
  const calls: (string | null)[] = [];
  let release: (() => void) | undefined;
  let failNext = false;
  const observation = observations();
  const peer = await httpPeer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://peer");
    if (!url.pathname.endsWith("/sync")) {
      json(response, {});
      return;
    }
    const since = url.searchParams.get("since");
    calls.push(since);
    if (failNext) {
      failNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    json(response, {
      next_batch: since ? "batch-after" : "batch-before",
      rooms: {
        join: {
          [room]: { timeline: { events: since ? [event("$after-restart", "recovered")] : [] } },
        },
      },
    });
  });
  const firstPlugin = createMatrixChannel({ MATRIX_TOKEN: "token" });
  const first = await harness(
    firstPlugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe },
  );
  await firstPlugin.start?.(new AbortController().signal);
  await waitFor(
    async () =>
      (await first.storage.getState({ pluginId: "channel-matrix", ownerId: "bot" }, "sync"))
        ?.value === "batch-before",
  );
  await firstPlugin.stop?.();
  failNext = true;
  await firstPlugin.start?.(new AbortController().signal);
  await waitFor(() => release !== undefined);
  await first.storage.close();
  release?.();
  await waitFor(() => observation.logs.some((entry) => entry.fields?.errorCode === "sync_failed"));
  await firstPlugin.stop?.();
  const nextPlugin = createMatrixChannel({ MATRIX_TOKEN: "token" });
  const next = await harness(
    nextPlugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { filename: first.filename },
  );
  await nextPlugin.start?.(new AbortController().signal);
  await waitFor(async () => (await next.storage.listInbound({ limit: 10 })).length === 1);
  await nextPlugin.stop?.();
  expect(calls.at(-1)).toBe("batch-before");
  expect((await next.storage.listInbound({ limit: 10 }))[0]?.snapshot.text).toBe("recovered");
  expect(
    (await next.storage.getState({ pluginId: "channel-matrix", ownerId: "bot" }, "sync"))?.value,
  ).toBe("batch-after");
});

it("refuses to advance a limited timeline from an existing checkpoint", async () => {
  const peer = await httpPeer((_request, response) => {
    json(response, {
      next_batch: "skipped",
      rooms: {
        join: { [room]: { timeline: { limited: true, events: [event("$limited", "recent")] } } },
      },
    });
  });
  const plugin = createMatrixChannel({ MATRIX_TOKEN: "token" });
  const observation = observations();
  const fixture = await harness(
    plugin,
    config(peer.base),
    [{ chatId: room, threadId: thread }],
    [user],
    `${peer.base}/dispatch`,
    { observe: observation.observe },
  );
  await fixture.storage.compareAndSetState(
    { pluginId: "channel-matrix", ownerId: "bot" },
    { key: "sync", expectedVersion: null, value: "older" },
  );
  await plugin.start?.(new AbortController().signal);
  await waitFor(() =>
    observation.logs.some((entry) => entry.fields?.errorCode === "sync_history_gap"),
  );
  await plugin.stop?.();
  expect(
    (await fixture.storage.getState({ pluginId: "channel-matrix", ownerId: "bot" }, "sync"))?.value,
  ).toBe("older");
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([]);
});

it.each([
  [429, "retryable"],
  [403, "rejected"],
  [503, "unknown"],
] as const)("maps HTTP %i without guessing send effects", async (status, outcome) => {
  const peer = await httpPeer((request, response) => {
    if (request.url?.includes("/state/")) {
      json(response, {}, 404);
    } else {
      response.setHeader("Retry-After", "7");
      json(response, {}, status);
    }
  });
  const plugin = createMatrixChannel({ MATRIX_TOKEN: "token" });
  await harness(plugin, config(peer.base), [{ chatId: room }], [user], `${peer.base}/dispatch`);
  const result = await plugin.send(
    input({
      channel: "matrix",
      accountId: "bot",
      chatId: room,
      data: { homeserver: peer.base, userId: "@bot:local.test" },
    }),
  );
  expect(result.status).toBe(outcome);
  if (result.status === "retryable") {
    expect(result.retryAfterMs).toBe(7000);
  }
});

it("rejects inline secrets and untrusted plaintext or credential-bearing homeservers", () => {
  const plugin = createMatrixChannel();
  expect(() =>
    plugin.validateConfig({ ...config("https://matrix.example"), accessToken: "plaintext" }),
  ).toThrow();
  expect(() => plugin.validateConfig(config("http://remote.example"))).toThrow();
  expect(() => plugin.validateConfig(config("https://user:password@matrix.example"))).toThrow();
  expect(() =>
    plugin.validateConfig({ ...config("http://127.0.0.1:9000"), allowInsecureLocalhost: false }),
  ).toThrow();
});

it("returns from start and aborts an outstanding sync connection on stop", async () => {
  let opened = false;
  let closed = false;
  const peer = await httpPeer((_request, response) => {
    opened = true;
    response.once("close", () => {
      closed = true;
    });
  });
  const plugin = createMatrixChannel({ MATRIX_TOKEN: "token" });
  await harness(plugin, config(peer.base), [{ chatId: room }], [user], `${peer.base}/dispatch`);
  await plugin.start?.(new AbortController().signal);
  await waitFor(() => opened);
  await plugin.stop?.();
  await waitFor(() => closed);
  expect(closed).toBe(true);
});
