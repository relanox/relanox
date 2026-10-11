import { randomUUID } from "node:crypto";
import type { Storage } from "@relanox/sdk";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  completion,
  required,
  snapshot,
  storageContract,
} from "../../../tests/contracts/storage-contract.js";
import { createPostgresStorage, postgresStoragePlugin } from "../src/index.js";

const enabled = Boolean(process.env.RELANOX_TEST_POSTGRES_URL);
const schemaName = () => `relanox_test_${randomUUID().replaceAll("-", "")}`;
const open = (schema: string): Storage =>
  createPostgresStorage({
    connectionString: { env: "RELANOX_TEST_POSTGRES_URL" },
    schema,
  });
async function drop(schema: string) {
  const connectionString = process.env.RELANOX_TEST_POSTGRES_URL;
  if (!connectionString) {
    throw new Error("Test PostgreSQL URL required");
  }
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

describe.skipIf(!enabled)("postgreSQL real database", () => {
  storageContract("PostgreSQL shared storage contract", async () => {
    const schema = schemaName();
    const storage = open(schema);
    return {
      ...storage,
      async close() {
        try {
          await storage.close();
        } finally {
          await drop(schema);
        }
      },
    };
  });

  it("requires explicit migration and retains fenced leases and processing claims across independent pools and restart", async () => {
    const schema = schemaName();
    let a = open(schema);
    const b = open(schema);
    try {
      expect(await a.health()).toEqual({
        ok: false,
        errorCode: "migration_required",
      });
      await a.migrate();
      await a.migrate();
      expect(await b.health()).toEqual({ ok: true });
      await a.acceptInbound(snapshot());
      const legacy = new Pool({ connectionString: process.env.RELANOX_TEST_POSTGRES_URL });
      try {
        await legacy.query(`DELETE FROM "${schema}".migration_metadata WHERE version=2`);
      } finally {
        await legacy.end();
      }
      expect(await a.health()).toEqual({ ok: false, errorCode: "migration_required" });
      await a.migrate();
      expect(await a.health()).toEqual({ ok: true });
      expect((await a.getInbound("r1"))?.snapshot.text).toBe("question");
      const input = {
        now: 100,
        leaseMs: 10,
        limit: 1,
        leaseOwner: "a",
        safeRetryAccountIds: [],
      };
      const attempts = await Promise.all([
        a.takeDue(input),
        b.takeDue({ ...input, leaseOwner: "b" }),
      ]);
      expect(attempts.flat()).toHaveLength(1);
      const oldLease = required(attempts.flat()[0]).lease;
      await a.close();
      a = open(schema);
      expect(await a.takeDue({ ...input, now: 110 })).toEqual([]);
      expect((await a.getInbound("r1"))?.dispatch).toMatchObject({
        status: "unknown",
        errorCode: "lease_expired",
      });
      expect(
        await a.settleAttempt({
          kind: "dispatch",
          id: "r1",
          lease: oldLease,
          outcome: { status: "accepted" },
          now: 110,
          nextDueAt: 111,
        }),
      ).toEqual({ status: "conflict" });
      const r = required(await a.getInbound("r1"));
      expect(
        await a.requeue({
          kind: "request",
          id: "r1",
          expectedVersion: r.version,
          now: 111,
          acknowledgeUnknown: true,
        }),
      ).toMatchObject({ status: "updated" });
      expect(
        await b.claimRequest({
          requestId: "r1",
          endpointIds: ["ep"],
          claimKey: "attempt",
          claimToken: "durable",
          now: 112,
        }),
      ).toMatchObject({ status: "claimed", replay: false });
      await a.close();
      a = open(schema);
      expect(
        await a.claimRequest({
          requestId: "r1",
          endpointIds: ["ep"],
          claimKey: "attempt",
          claimToken: "new",
          now: 1000,
        }),
      ).toMatchObject({
        status: "claimed",
        claimToken: "durable",
        replay: true,
      });
      expect(await a.takeDue({ ...input, now: 1000 })).toEqual([]);
    } finally {
      await a.close();
      await b.close();
      await drop(schema);
    }
  });

  it("serializes source dedup, endpoint FIFO, global final IDs and state CAS across separate pools", async () => {
    const schema = schemaName();
    const a = open(schema);
    const b = open(schema);
    try {
      await a.migrate();
      const receipts = await Promise.all([
        a.acceptInbound(snapshot()),
        b.acceptInbound({ ...snapshot("other"), source: snapshot().source }),
      ]);
      expect(receipts.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(receipts.map((r) => r.requestId)).size).toBe(1);
      const firstId = required(receipts[0]).requestId;
      await a.acceptInbound(snapshot("r2", 101));
      const claim = (s: Storage, id: string, token: string) =>
        s.claimRequest({
          requestId: id,
          endpointIds: ["ep", "independent"],
          claimKey: token,
          claimToken: token,
          now: 105,
        });
      const claims = await Promise.all([claim(a, firstId, "first"), claim(b, "r2", "second")]);
      expect(claims[0]).toMatchObject({ status: "claimed" });
      expect(claims[1]).toEqual({ status: "busy" });
      await a.acceptInbound(snapshot("r3", 101, "independent"));
      expect(await claim(b, "r3", "third")).toMatchObject({
        status: "claimed",
      });
      const sharedFinal = "only-final";
      const finals = await Promise.all([
        a.completeAndEnqueue({
          ...completion(firstId, "first", sharedFinal),
          endpointIds: ["ep"],
        }),
        b.completeAndEnqueue({
          ...completion("r3", "third", sharedFinal),
          endpointIds: ["independent"],
        }),
      ]);
      expect(finals.filter((r) => r.status === "completed")).toHaveLength(1);
      expect(finals.filter((r) => r.status === "conflict")).toHaveLength(1);
      expect(await a.listOutbound({ limit: 10 })).toHaveLength(1);
      expect(await a.listInbound({ requestStatus: "completed", limit: 10 })).toHaveLength(1);
      expect(await a.listInbound({ requestStatus: "claimed", limit: 10 })).toHaveLength(1);
      const ns = { pluginId: "dot", ownerId: "a" };
      const creates = await Promise.all([
        a.compareAndSetState(ns, {
          key: "cursor",
          expectedVersion: null,
          value: "a",
        }),
        b.compareAndSetState(ns, {
          key: "cursor",
          expectedVersion: null,
          value: "b",
        }),
      ]);
      expect(creates.filter((r) => r.status === "updated")).toHaveLength(1);
      expect(creates.filter((r) => r.status === "conflict")).toHaveLength(1);
      const updates = await Promise.all([
        a.compareAndSetState(ns, {
          key: "cursor",
          expectedVersion: 1,
          value: "next-a",
        }),
        b.compareAndSetState(ns, {
          key: "cursor",
          expectedVersion: 1,
          value: "next-b",
        }),
      ]);
      expect(updates.filter((r) => r.status === "updated")).toEqual([
        { status: "updated", version: 2 },
      ]);
      expect(updates.filter((r) => r.status === "conflict")).toHaveLength(1);
      expect((await a.getState(ns, "cursor"))?.version).toBe(2);
    } finally {
      await a.close();
      await b.close();
      await drop(schema);
    }
  });

  it("filters eligible FIFO endpoints before bounded scans and applies literal prefix, admin scopes and bounded retention", async () => {
    const schema = schemaName();
    const s = open(schema);
    try {
      await s.migrate();
      await s.acceptInbound(snapshot("a-head", 100, "blocked"));
      await s.claimRequest({
        requestId: "a-head",
        endpointIds: ["blocked"],
        claimKey: "head",
        claimToken: "head",
        now: 101,
      });
      for (const id of ["a-next1", "a-next2", "a-next3"]) {
        await s.acceptInbound(snapshot(id, 101, "blocked"));
      }
      const pull = snapshot("b-pull", 102, "pull");
      await s.acceptInbound({
        ...pull,
        endpoint: { ...pull.endpoint, dispatchMode: "pull" },
      });
      await s.acceptInbound(snapshot("c-due", 103, "ep"));
      expect(
        (
          await s.takeDue({
            now: 104,
            leaseMs: 10,
            limit: 1,
            leaseOwner: "worker",
            safeRetryAccountIds: [],
          })
        ).map((w) => (w.kind === "dispatch" ? w.record.snapshot.requestId : w.record.deliveryId)),
      ).toEqual(["c-due"]);
      expect(
        (
          await s.listInbound({
            endpointId: "blocked",
            requestStatus: "pending",
            deliveryStatus: "sent",
            limit: 1,
            afterId: "a-next1",
          })
        ).map((r) => r.snapshot.requestId),
      ).toEqual(["a-next2"]);
      expect(
        (await s.listPending({ endpointIds: ["pull"], limit: 1 })).map((r) => r.requestId),
      ).toEqual(["b-pull"]);
      const ns = { pluginId: "dot", ownerId: "a" };
      for (const [key, expiry] of [
        ["sub%_1", 100],
        ["sub%_2", 200],
        ["sub-other", 100],
        ["sub%_0", undefined],
      ] as const) {
        await s.compareAndSetState(ns, {
          key,
          expectedVersion: null,
          value: key,
          ...(expiry !== undefined ? { expiresAt: expiry } : {}),
        });
      }
      expect(
        (
          await s.listState(ns, {
            prefix: "sub%_",
            expiresBefore: 100,
            limit: 1,
          })
        ).map((r) => r.key),
      ).toEqual(["sub%_1"]);
      await s.claimRequest({
        requestId: "c-due",
        endpointIds: ["ep"],
        claimKey: "final",
        claimToken: "final",
        now: 105,
      });
      await s.completeAndEnqueue(completion("c-due", "final"));
      expect(await s.listOutbound({ endpointId: "blocked", limit: 10 })).toEqual([]);
      expect(
        (
          await s.listOutbound({
            endpointId: "ep",
            deliveryStatus: "pending",
            requestStatus: "failed",
            limit: 1,
            afterId: "d-a",
          })
        ).map((r) => r.deliveryId),
      ).toEqual(["d-c-due"]);
      for (let i = 0; i < 2; i++) {
        const w = required(
          (
            await s.takeDue({
              now: 110 + i,
              leaseMs: 10,
              limit: 10,
              leaseOwner: "send",
              safeRetryAccountIds: [],
            })
          ).find((candidate) => candidate.kind === "send"),
        );
        await s.settleAttempt({
          kind: "send",
          id: "d-c-due",
          lease: w.lease,
          outcome: {
            status: "sent",
            receipt: { platformMessageId: `sent-${i}` },
          },
          now: 110 + i,
          nextDueAt: 111 + i,
        });
      }
      await s.fail({
        requestId: "a-head",
        endpointIds: ["blocked"],
        claimToken: "head",
        errorCode: "remote_failure",
        now: 112,
      });
      expect(await s.cleanup({ before: 1000, limit: 1 })).toEqual({
        redacted: 1,
      });
      expect((await s.getInbound("a-head"))?.snapshot.text).toBe("");
      expect((await s.getInbound("c-due"))?.snapshot.text).toBe("question");
      expect(await s.cleanup({ before: 1000, limit: 1 })).toEqual({
        redacted: 1,
      });
      expect((await s.getInbound("c-due"))?.snapshot.text).toBe("");
      expect((await s.getInbound("a-next1"))?.snapshot.text).toBe("question");
      expect(await s.cleanup({ before: 1000, limit: 1 })).toEqual({
        redacted: 0,
      });
    } finally {
      await s.close();
      await drop(schema);
    }
  });

  it("blocks a newly inserted lower FIFO ID while its endpoint has an active claim or dispatch lease", async () => {
    const schema = schemaName();
    const a = open(schema);
    const b = open(schema);
    try {
      await a.migrate();
      await a.acceptInbound(snapshot("z-claimed", 100, "claimed"));
      await a.claimRequest({
        requestId: "z-claimed",
        endpointIds: ["claimed"],
        claimKey: "old",
        claimToken: "old",
        now: 101,
      });
      await b.acceptInbound(snapshot("a-new", 100, "claimed"));
      expect(
        await b.claimRequest({
          requestId: "a-new",
          endpointIds: ["claimed"],
          claimKey: "new",
          claimToken: "new",
          now: 102,
        }),
      ).toEqual({ status: "busy" });
      expect(
        await b.takeDue({
          now: 102,
          leaseMs: 10,
          limit: 10,
          leaseOwner: "b",
          safeRetryAccountIds: [],
        }),
      ).toEqual([]);
      await a.acceptInbound(snapshot("z-dispatch", 101, "dispatch"));
      expect(
        (
          await a.takeDue({
            now: 102,
            leaseMs: 10,
            limit: 10,
            leaseOwner: "a",
            safeRetryAccountIds: [],
          })
        ).map((w) => (w.kind === "dispatch" ? w.record.snapshot.requestId : w.record.deliveryId)),
      ).toEqual(["z-dispatch"]);
      await b.acceptInbound(snapshot("a-dispatch", 101, "dispatch"));
      await b.acceptInbound(snapshot("free", 102, "free"));
      expect(
        (
          await b.takeDue({
            now: 103,
            leaseMs: 10,
            limit: 10,
            leaseOwner: "b",
            safeRetryAccountIds: [],
          })
        ).map((w) => (w.kind === "dispatch" ? w.record.snapshot.requestId : w.record.deliveryId)),
      ).toEqual(["free"]);
      expect(
        await b.claimRequest({
          requestId: "a-dispatch",
          endpointIds: ["dispatch"],
          claimKey: "new",
          claimToken: "new",
          now: 103,
        }),
      ).toEqual({ status: "busy" });
      expect(
        await a.claimRequest({
          requestId: "z-dispatch",
          endpointIds: ["dispatch"],
          claimKey: "original",
          claimToken: "original",
          now: 104,
        }),
      ).toMatchObject({ status: "claimed", replay: false });
    } finally {
      await a.close();
      await b.close();
      await drop(schema);
    }
  });

  it("reopens partial delivery receipts and resumes the same unsent chunk only after explicit unknown recovery", async () => {
    const schema = schemaName();
    let a = open(schema);
    const b = open(schema);
    try {
      await a.migrate();
      await a.acceptInbound(snapshot());
      await a.claimRequest({
        requestId: "r1",
        endpointIds: ["ep"],
        claimKey: "claim",
        claimToken: "token",
        now: 105,
      });
      await a.completeAndEnqueue(completion());
      const due = (s: Storage, now: number) =>
        s.takeDue({
          now,
          leaseMs: 10,
          limit: 1,
          leaseOwner: "send",
          safeRetryAccountIds: [],
        });
      const first = required((await due(a, 110))[0]);
      expect(
        await b.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease: first.lease,
          outcome: {
            status: "sent",
            receipt: { platformMessageId: "first-chunk" },
          },
          now: 111,
          nextDueAt: 112,
        }),
      ).toMatchObject({ status: "updated" });
      const unsent = required((await due(b, 112))[0]);
      await a.close();
      a = open(schema);
      expect(await a.getOutbound("d-r1")).toMatchObject({
        currentChunk: 1,
        attempts: 0,
        receipts: [{ platformMessageId: "first-chunk" }],
        lease: unsent.lease,
      });
      expect(await due(a, 122)).toEqual([]);
      const unknown = required(await a.getOutbound("d-r1"));
      expect(unknown.status).toBe("unknown");
      expect(
        await a.requeue({
          kind: "delivery",
          id: "d-r1",
          expectedVersion: unknown.version,
          now: 123,
          acknowledgeUnknown: true,
        }),
      ).toMatchObject({ status: "updated" });
      const next = required((await due(a, 123))[0]);
      expect(next.kind).toBe("send");
      if (next.kind === "send") {
        expect(next.record).toMatchObject({
          currentChunk: 1,
          chunks: [{ idempotencyKey: "c1" }, { idempotencyKey: "c2" }],
          receipts: [{ platformMessageId: "first-chunk" }],
        });
      }
      expect(
        await b.settleAttempt({
          kind: "send",
          id: "d-r1",
          lease: unsent.lease,
          outcome: { status: "sent", receipt: { platformMessageId: "stale" } },
          now: 124,
          nextDueAt: 125,
        }),
      ).toEqual({ status: "conflict" });
      await b.settleAttempt({
        kind: "send",
        id: "d-r1",
        lease: next.lease,
        outcome: {
          status: "sent",
          receipt: { platformMessageId: "second-chunk" },
        },
        now: 124,
        nextDueAt: 125,
      });
      expect(await a.getOutbound("d-r1")).toMatchObject({
        status: "sent",
        currentChunk: 2,
        receipts: [{ platformMessageId: "first-chunk" }, { platformMessageId: "second-chunk" }],
      });
    } finally {
      await a.close();
      await b.close();
      await drop(schema);
    }
  });
});

it("validates SecretRef, SQL identifiers and bounded pool config without exposing missing credentials", () => {
  const base = { connectionString: { env: "RELANOX_TEST_POSTGRES_URL" } };
  expect(postgresStoragePlugin.validateConfig(base)).toMatchObject({
    connectionString: base.connectionString,
    schema: "public",
    maxConnections: 10,
  });
  for (const input of [
    { connectionString: "postgresql://secret" },
    { ...base, schema: "public; DROP SCHEMA public" },
    { ...base, maxConnections: 0 },
    { ...base, statementTimeoutMs: 0 },
    { ...base, unrecognized: true },
  ]) {
    expect(() => postgresStoragePlugin.validateConfig(input)).toThrow();
  }
  expect(() =>
    createPostgresStorage({
      connectionString: {
        env: `RELANOX_MISSING_${randomUUID().replaceAll("-", "")}`,
      },
    }),
  ).toThrow("PostgreSQL connection secret is unavailable");
});
