import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompleteInput, InboundSnapshot, Storage } from "../../packages/sdk/src/index.js";

export function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Required durable record is absent");
  }
  return value;
}

export const snapshot = (id = "r1", at = 100, endpoint = "ep"): InboundSnapshot => ({
  requestId: id,
  source: { channel: "telegram", accountId: "a", eventId: id },
  senderId: "u",
  text: "question",
  target: {
    channel: "telegram",
    accountId: "a",
    chatId: "chat",
    data: { thread: "original" },
  },
  receivedAt: at,
  acceptedAt: at,
  context: { original: true },
  endpoint: {
    id: endpoint,
    agent: "grok",
    dispatchMode: "push",
    config: { url: "https://agent.example", secret: { env: "TOKEN" } },
  },
});

export const completion = (id = "r1", token = "token", resultId = "final"): CompleteInput => ({
  requestId: id,
  agent: "grok",
  endpointIds: ["ep"],
  claimToken: token,
  result: { resultId, text: "AB", completedAt: 110 },
  outbound: {
    deliveryId: `d-${id}`,
    requestId: id,
    resultId,
    target: snapshot(id).target,
    chunks: [
      { text: "A", idempotencyKey: "c1", state: { seq: 1 } },
      { text: "B", idempotencyKey: "c2", state: { seq: 2 } },
    ],
    currentChunk: 0,
    receipts: [],
    status: "pending",
    version: 1,
    attempts: 0,
    dueAt: 110,
    createdAt: 110,
  },
});

export function storageContract(name: string, open: () => Promise<Storage>) {
  describe(name, () => {
    let s: Storage;
    beforeEach(async () => {
      s = await open();
      await s.initialize();
    });
    afterEach(async () => {
      await s.close();
    });

    const claim = (id = "r1", key = "try", token = "token") =>
      s.claimRequest({
        requestId: id,
        agent: "grok",
        endpointIds: ["ep"],
        claimKey: key,
        claimToken: token,
        now: 105,
      });

    const due = (now = 110, safeRetryAccountIds: string[] = []) =>
      s.takeDue({
        now,
        leaseMs: 10,
        limit: 10,
        leaseOwner: "worker",
        safeRetryAccountIds,
      });

    it.each([99, 100])(
      "holds endpoint exclusivity when a later accepted request sorts before its active claim (%i)",
      async (timestamp) => {
        await s.acceptInbound(snapshot("z-active", 100));
        expect(await claim("z-active")).toMatchObject({ status: "claimed" });
        await s.acceptInbound(snapshot("a-later", timestamp));
        expect(await claim("a-later")).toMatchObject({ status: "busy" });
        expect(await due(110)).toEqual([]);
        expect(
          await s.fail({
            requestId: "z-active",
            agent: "grok",
            endpointIds: ["ep"],
            claimToken: "token",
            errorCode: "remote_failed",
            now: 111,
          }),
        ).toMatchObject({ status: "updated" });
        expect(await claim("a-later")).toMatchObject({ status: "claimed" });
      },
    );

    it.each(["rejected", "unknown"] as const)(
      "preserves dispatch ownership and explicit %s recovery across later reordered acceptance",
      async (status) => {
        await s.acceptInbound(snapshot("z-active", 100));
        const work = required((await due(100))[0]);
        expect(work.kind).toBe("dispatch");
        await s.acceptInbound(snapshot("a-later", 100));
        expect(await due(101)).toEqual([]);
        expect(await claim("a-later")).toMatchObject({ status: "busy" });
        expect(
          await s.settleAttempt({
            kind: "dispatch",
            id: "z-active",
            lease: work.lease,
            outcome: { status, errorCode: "remote_problem" },
            now: 102,
            nextDueAt: 102,
          }),
        ).toMatchObject({ status: "updated" });
        expect(await due(103)).toEqual([]);
        expect(await claim("a-later")).toMatchObject({ status: "busy" });
        const stopped = required(await s.getInbound("z-active"));
        expect(
          await s.requeue({
            kind: "request",
            id: "z-active",
            expectedVersion: stopped.version,
            now: 104,
            acknowledgeUnknown: true,
          }),
        ).toMatchObject({ status: "updated" });
        expect(await claim("a-later")).toMatchObject({ status: "claimed" });
      },
    );

    it("keeps the already notified request claimable after reordered acceptance", async () => {
      await s.acceptInbound(snapshot("z-active", 100));
      const work = required((await due(100))[0]);
      expect(
        await s.settleAttempt({
          kind: "dispatch",
          id: "z-active",
          lease: work.lease,
          outcome: { status: "accepted" },
          now: 101,
          nextDueAt: 200,
        }),
      ).toMatchObject({ status: "updated" });
      await s.acceptInbound(snapshot("a-later", 100));
      expect(await due(102)).toEqual([]);
      expect(await claim("a-later")).toMatchObject({ status: "busy" });
      expect(await claim("z-active")).toMatchObject({ status: "claimed" });
    });

    it("starts a fresh delivery retry budget on explicit recovery", async () => {
      await s.acceptInbound(snapshot());
      await claim();
      await s.completeAndEnqueue(completion());
      const first = required((await due(110))[0]);
      await s.settleAttempt({
        kind: "send",
        id: "d-r1",
        lease: first.lease,
        outcome: { status: "retryable", errorCode: "rate_limit" },
        now: 111,
        nextDueAt: 112,
      });
      const second = required((await due(112))[0]);
      await s.settleAttempt({
        kind: "send",
        id: "d-r1",
        lease: second.lease,
        outcome: { status: "rejected", errorCode: "retry_budget_exhausted" },
        now: 113,
        nextDueAt: 113,
      });
      const rejected = required(await s.getOutbound("d-r1"));
      expect(rejected.attempts).toBe(2);
      expect(
        await s.requeue({
          kind: "delivery",
          id: "d-r1",
          expectedVersion: rejected.version,
          now: 114,
          acknowledgeUnknown: false,
        }),
      ).toMatchObject({ status: "updated" });
      expect(await s.getOutbound("d-r1")).toMatchObject({
        attempts: 0,
        currentChunk: 0,
        receipts: [],
        status: "pending",
        chunks: [{ idempotencyKey: "c1" }, { idempotencyKey: "c2" }],
      });
      expect(await due(114)).toHaveLength(1);
    });

    it("serializes acceptance and retains source deduplication", async () => {
      const input = snapshot();
      await s.acceptInbound(input);
      (input.target.data as Record<string, unknown>).thread = "changed";
      expect((await s.getInbound("r1"))?.snapshot.target.data).toEqual({
        thread: "original",
      });
      expect(
        await s.acceptInbound({
          ...snapshot("other"),
          source: snapshot().source,
        }),
      ).toEqual({ requestId: "r1", duplicate: true });
      const read = await s.getInbound("r1");
      if (!read) {
        throw new Error("Accepted request is missing");
      }
      (read.snapshot.endpoint.config as Record<string, unknown>).url = "changed";
      expect((await s.getInbound("r1"))?.snapshot.endpoint.config).toEqual({
        url: "https://agent.example",
        secret: { env: "TOKEN" },
      });
    });

    it("retains agent-kind authority when an endpoint ID is reused", async () => {
      const old = snapshot("old", 100);
      await s.acceptInbound({ ...old, endpoint: { ...old.endpoint, agent: "dot" } });
      await s.acceptInbound(snapshot("new", 101));
      expect(
        (await s.listPending({ agent: "grok", endpointIds: ["ep"], limit: 1 })).map(
          (request) => request.requestId,
        ),
      ).toEqual(["new"]);

      const claimInput = {
        requestId: "old",
        endpointIds: ["ep"],
        claimKey: "original",
        claimToken: "old-token",
        now: 105,
      };

      expect(await s.claimRequest({ ...claimInput, agent: "grok" })).toEqual({
        status: "not_found",
      });
      expect(await s.claimRequest({ ...claimInput, agent: "dot" })).toMatchObject({
        status: "claimed",
        replay: false,
      });
      expect(await s.claimRequest({ ...claimInput, agent: "grok" })).toEqual({
        status: "not_found",
      });
      expect(
        await s.completeAndEnqueue({ ...completion("old", "old-token"), agent: "grok" }),
      ).toEqual({ status: "unauthorized" });
      expect(
        await s.fail({
          requestId: "old",
          endpointIds: ["ep"],
          agent: "grok",
          claimToken: "old-token",
          errorCode: "foreign_failure",
          now: 110,
        }),
      ).toEqual({ status: "unauthorized" });
      expect((await s.getInbound("old"))?.status).toBe("claimed");
      expect(await s.getOutbound("d-old")).toBeUndefined();
      expect(
        await s.completeAndEnqueue({ ...completion("old", "old-token"), agent: "dot" }),
      ).toMatchObject({ status: "completed", replay: false });
    });

    it("enforces scoped endpoint FIFO and idempotent claim keys", async () => {
      await s.acceptInbound(snapshot());
      await s.acceptInbound(snapshot("r2", 101));
      expect(await claim("r2")).toEqual({ status: "busy" });
      expect(await s.listPending({ agent: "grok", endpointIds: ["other"], limit: 10 })).toEqual([]);
      expect(
        await s.claimRequest({
          requestId: "r1",
          agent: "grok",
          endpointIds: ["other"],
          claimKey: "try",
          claimToken: "x",
          now: 105,
        }),
      ).toEqual({ status: "not_found" });
      expect(await claim()).toMatchObject({
        status: "claimed",
        claimToken: "token",
        replay: false,
      });
      expect(await claim("r1", "try", "replacement")).toMatchObject({
        claimToken: "token",
        replay: true,
      });
      expect(await claim("r1", "other")).toEqual({ status: "busy" });
      expect(await claim("r2")).toEqual({ status: "busy" });
    });

    it("atomically validates frozen final/outbound and replay identity", async () => {
      await s.acceptInbound(snapshot());
      await claim();
      const bad = completion();

      const forged = {
        ...bad,
        outbound: {
          ...bad.outbound,
          target: { ...bad.outbound.target, chatId: "attacker" },
        },
      };

      expect(await s.completeAndEnqueue(forged)).toEqual({
        status: "conflict",
      });
      expect(await s.getOutbound("d-r1")).toBeUndefined();
      expect((await s.getInbound("r1"))?.status).toBe("claimed");
      expect(await s.completeAndEnqueue({ ...bad, agent: "grok", endpointIds: ["other"] })).toEqual(
        {
          status: "unauthorized",
        },
      );
      expect(await s.completeAndEnqueue(bad)).toEqual({
        status: "completed",
        deliveryId: "d-r1",
        replay: false,
      });
      expect(
        await s.completeAndEnqueue({
          ...bad,
          result: { ...bad.result, completedAt: 999 },
        }),
      ).toEqual({ status: "completed", deliveryId: "d-r1", replay: true });
      expect(
        await s.completeAndEnqueue({
          ...bad,
          result: { ...bad.result, text: "different" },
        }),
      ).toEqual({ status: "conflict" });
      await s.acceptInbound(snapshot("r2", 101));
      await claim("r2");
      expect(await s.completeAndEnqueue(completion("r2"))).toEqual({
        status: "conflict",
      });
      expect(await s.getOutbound("d-r2")).toBeUndefined();
    });

    it("fences concurrent leases and persists partial chunk receipts and unknown recovery", async () => {
      await s.acceptInbound(snapshot());
      await claim();
      await s.completeAndEnqueue(completion());
      const [one, two] = await Promise.all([due(), due()]);
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(0);
      const lease = required(one[0]).lease;
      expect(
        await s.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease: { ...lease, token: "wrong" },
          outcome: { status: "sent", receipt: {} },
          now: 111,
          nextDueAt: 112,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await s.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease,
          outcome: { status: "sent", receipt: { platformMessageId: "p1" } },
          now: 111,
          nextDueAt: 112,
        }),
      ).toMatchObject({ status: "updated" });
      expect(await s.getOutbound("d-r1")).toMatchObject({
        currentChunk: 1,
        attempts: 0,
        receipts: [{ platformMessageId: "p1" }],
        status: "pending",
      });
      const next = required((await due(112))[0]);
      expect(await due(122)).toEqual([]);
      expect((await s.getOutbound("d-r1"))?.status).toBe("unknown");
      expect(
        await s.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease: next.lease,
          outcome: { status: "sent", receipt: {} },
          now: 122,
          nextDueAt: 122,
        }),
      ).toEqual({ status: "conflict" });
      const unknown = required(await s.getOutbound("d-r1"));
      expect(
        await s.requeue({
          kind: "delivery",
          id: unknown.deliveryId,
          expectedVersion: unknown.version,
          now: 123,
          acknowledgeUnknown: false,
        }),
      ).toEqual({ status: "conflict" });
      await s.requeue({
        kind: "delivery",
        id: unknown.deliveryId,
        expectedVersion: unknown.version,
        now: 123,
        acknowledgeUnknown: true,
      });
      await due(123);
      const safe = await due(133, ["a"]);
      expect(safe).toHaveLength(1);
      if (safe[0]?.kind === "send") {
        expect(safe[0].record).toMatchObject({
          currentChunk: 1,
          chunks: [{ idempotencyKey: "c1" }, { idempotencyKey: "c2" }],
        });
      }
    });

    it("keeps processing claims durable and revokes tokens on explicit recovery", async () => {
      await s.acceptInbound(snapshot());
      const work = required((await due(100))[0]);
      await claim();
      expect(await due(1000)).toEqual([]);
      expect(
        await s.settleAttempt({
          kind: "dispatch",
          id: "r1",
          lease: work.lease,
          outcome: { status: "accepted" },
          now: 106,
          nextDueAt: 107,
        }),
      ).toEqual({ status: "conflict" });
      const r = required(await s.getInbound("r1"));
      await s.requeue({
        kind: "request",
        id: "r1",
        expectedVersion: r.version,
        now: 1000,
        acknowledgeUnknown: false,
      });
      await claim("r1", "new", "new-token");
      expect(await s.completeAndEnqueue(completion())).toEqual({
        status: "unauthorized",
      });
    });

    it("clears unknown notification counts after claim while preserving uncertain deliveries", async () => {
      await s.acceptInbound(snapshot());
      const dispatch = required((await due(100))[0]);
      await s.settleAttempt({
        kind: "dispatch",
        id: "r1",
        lease: dispatch.lease,
        outcome: { status: "unknown", errorCode: "connection_lost" },
        now: 101,
        nextDueAt: 101,
      });
      expect((await s.getStats()).unknown).toBe(1);
      expect(await claim()).toMatchObject({ status: "claimed" });
      expect((await s.getStats()).unknown).toBe(0);
      expect(await s.completeAndEnqueue(completion())).toMatchObject({ status: "completed" });
      expect((await s.getStats()).unknown).toBe(0);
      const send = required((await due(110))[0]);
      await s.settleAttempt({
        kind: "send",
        id: "d-r1",
        lease: send.lease,
        outcome: { status: "unknown", errorCode: "connection_lost" },
        now: 111,
        nextDueAt: 111,
      });
      expect((await s.getStats()).unknown).toBe(1);
    });

    it("fences stale state mutations across delete and recreate without hiding null values", async () => {
      const ns = { pluginId: "dot", ownerId: "ep" };

      const initial = await s.compareAndSetState(ns, {
        key: "subscription",
        expectedVersion: null,
        value: "old-secret",
      });

      expect(initial).toEqual({ status: "updated", version: 1 });
      expect(await s.deleteState(ns, "subscription", 1)).toEqual({ status: "updated", version: 2 });
      expect(await s.getState(ns, "subscription")).toBeUndefined();
      expect(await s.listState(ns, { limit: 10 })).toEqual([]);
      expect(await s.deleteState(ns, "subscription", 2)).toEqual({ status: "not_found" });
      expect(
        await s.compareAndSetState(ns, { key: "subscription", expectedVersion: 2, value: "stale" }),
      ).toEqual({ status: "conflict" });
      expect(
        await s.compareAndSetState(ns, { key: "subscription", expectedVersion: null, value: null }),
      ).toEqual({ status: "updated", version: 3 });
      expect(await s.deleteState(ns, "subscription", 1)).toEqual({ status: "conflict" });
      expect(
        await s.compareAndSetState(ns, { key: "subscription", expectedVersion: 1, value: "stale" }),
      ).toEqual({ status: "conflict" });
      expect(await s.getState(ns, "subscription")).toEqual({
        key: "subscription",
        value: null,
        version: 3,
      });
      expect(await s.listState(ns, { prefix: "sub", limit: 10 })).toEqual([
        { key: "subscription", value: null, version: 3 },
      ]);
    });

    it("uses namespaced state CAS and database admin aggregates", async () => {
      const ns = { pluginId: "dot", ownerId: "a" };
      expect(
        await s.compareAndSetState(ns, {
          key: "sub:1",
          expectedVersion: null,
          value: { url: "original" },
          expiresAt: 120,
        }),
      ).toEqual({ status: "updated", version: 1 });
      expect(
        await s.compareAndSetState(ns, {
          key: "sub:1",
          expectedVersion: null,
          value: null,
        }),
      ).toEqual({ status: "conflict" });
      expect(await s.getState({ ...ns, ownerId: "b" }, "sub:1")).toBeUndefined();
      expect(await s.listState(ns, { prefix: "sub:", expiresBefore: 120, limit: 1 })).toEqual([
        {
          key: "sub:1",
          value: { url: "original" },
          expiresAt: 120,
          version: 1,
        },
      ]);
      expect(await s.deleteState(ns, "sub:1", 9)).toEqual({
        status: "conflict",
      });
      expect(
        await s.compareAndSetState(ns, {
          key: "sub:1",
          expectedVersion: 1,
          value: "next",
        }),
      ).toEqual({ status: "updated", version: 2 });
      expect(await s.deleteState(ns, "sub:1", 2)).toEqual({
        status: "updated",
        version: 3,
      });
      await s.acceptInbound(snapshot());
      await s.acceptInbound(snapshot("r2", 101));
      await claim();
      expect(await s.getStats()).toEqual({
        pending: 1,
        claimed: 1,
        undelivered: 0,
        unknown: 0,
        oldestPendingAt: 101,
      });
      expect(
        (await s.listInbound({ limit: 1, afterId: "r1" })).map((x) => x.snapshot.requestId),
      ).toEqual(["r2"]);
    });

    it("redacts only terminal delivered work while preserving replay equality", async () => {
      await s.acceptInbound(snapshot());
      await claim();
      await s.completeAndEnqueue(completion());
      await s.acceptInbound(snapshot("r2", 101));
      expect(await s.cleanup({ before: 1000, limit: 10 })).toEqual({
        redacted: 0,
      });
      for (let i = 0; i < 2; i++) {
        const w = required((await due(110 + i)).find((x) => x.kind === "send"));
        await s.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease: w.lease,
          outcome: { status: "sent", receipt: { platformMessageId: `p${i}` } },
          now: 110 + i,
          nextDueAt: 111 + i,
        });
      }
      expect(await s.cleanup({ before: 1000, limit: 10 })).toEqual({
        redacted: 1,
      });
      expect((await s.getInbound("r1"))?.snapshot).toMatchObject({
        text: "",
        context: null,
      });
      expect((await s.getInbound("r2"))?.snapshot.text).toBe("question");
      expect(await s.acceptInbound(snapshot())).toEqual({
        requestId: "r1",
        duplicate: true,
      });
      expect(await s.completeAndEnqueue(completion())).toMatchObject({
        status: "completed",
        replay: true,
      });
      expect(
        await s.completeAndEnqueue({
          ...completion(),
          result: { resultId: "final", text: "changed", completedAt: 110 },
        }),
      ).toEqual({ status: "conflict" });
    });

    it("recovers rejected dispatch explicitly and releases FIFO after finalization", async () => {
      await s.acceptInbound(snapshot());
      await s.acceptInbound(snapshot("r2", 101));
      const w = required((await due(100))[0]);
      await s.settleAttempt({
        kind: "dispatch",
        id: "r1",
        lease: w.lease,
        outcome: { status: "rejected", errorCode: "exhausted" },
        now: 101,
        nextDueAt: 101,
      });
      expect(await due(102)).toEqual([]);
      const r = required(await s.getInbound("r1"));
      expect(
        await s.requeue({
          kind: "request",
          id: "r1",
          expectedVersion: r.version - 1,
          now: 103,
          acknowledgeUnknown: false,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await s.requeue({
          kind: "request",
          id: "r1",
          expectedVersion: r.version,
          now: 103,
          acknowledgeUnknown: false,
        }),
      ).toMatchObject({ status: "updated" });
      await claim();
      await s.completeAndEnqueue(completion());
      expect(await claim("r2")).toMatchObject({ status: "claimed" });
      const final = required(await s.getInbound("r1"));
      expect(
        await s.requeue({
          kind: "request",
          id: "r1",
          expectedVersion: final.version,
          now: 104,
          acknowledgeUnknown: true,
        }),
      ).toEqual({ status: "conflict" });
      const send = required((await due()).find((x) => x.kind === "send"));
      await s.settleAttempt({
        kind: "send",
        id: "d-r1",
        lease: send.lease,
        outcome: { status: "retryable", errorCode: "rate_limit" },
        now: 111,
        nextDueAt: 150,
      });
      expect(await due(149)).toEqual([]);
      const retry = required((await due(150))[0]);
      if (retry.kind === "send") {
        expect(retry.record).toMatchObject({
          currentChunk: 0,
          receipts: [],
          chunks: [{ idempotencyKey: "c1" }, { idempotencyKey: "c2" }],
          attempts: 1,
        });
      }
    });

    it("rejects non-JSON durable data and rolls back outbound/final on serialization failure", async () => {
      await expect(
        s.acceptInbound({
          ...snapshot(),
          context: { bad: undefined } as never,
        }),
      ).rejects.toThrow();
      expect(await s.getInbound("r1")).toBeUndefined();
      await s.acceptInbound(snapshot());
      await claim();
      const input = completion();
      await expect(
        s.completeAndEnqueue({
          ...input,
          outbound: {
            ...input.outbound,
            trace: { traceparent: undefined } as never,
          },
        }),
      ).rejects.toThrow();
      expect(await s.getOutbound("d-r1")).toBeUndefined();
      expect((await s.getInbound("r1"))?.status).toBe("claimed");
      expect(await s.completeAndEnqueue(input)).toMatchObject({
        status: "completed",
      });
    });

    it("scopes idempotent failure and preserves failed recovery fences", async () => {
      await s.acceptInbound(snapshot());
      await claim();

      const input = {
        requestId: "r1",
        agent: "grok" as const,
        endpointIds: ["ep"],
        claimToken: "token",
        errorCode: "remote_failed",
        now: 106,
      };

      expect(await s.fail({ ...input, agent: "grok", endpointIds: ["foreign"] })).toEqual({
        status: "unauthorized",
      });
      expect(await s.fail(input)).toMatchObject({ status: "updated" });
      const r = required(await s.getInbound("r1"));
      expect(await s.fail(input)).toEqual({
        status: "updated",
        version: r.version,
      });
      expect(await s.cleanup({ before: 1000, limit: 1 })).toEqual({
        redacted: 1,
      });
      expect((await s.getInbound("r1"))?.snapshot.text).toBe("");
      expect(
        await s.requeue({
          kind: "request",
          id: "r1",
          expectedVersion: r.version,
          now: 1001,
          acknowledgeUnknown: true,
        }),
      ).toEqual({ status: "conflict" });
    });
  });
}
