import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { required, snapshot, storageContract } from "../../../tests/contracts/storage-contract.js";
import { createSqliteStorage } from "../src/index.js";

storageContract("SQLite shared storage contract", async () =>
  createSqliteStorage({ filename: ":memory:", busyTimeoutMs: 5000 }),
);

it("requires explicit migration and persists fenced claims/leases across independent connections and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relanox-sqlite-"));
  const filename = join(dir, "relay.db");
  const open = () => createSqliteStorage({ filename, busyTimeoutMs: 5000 });
  let a = open();
  let b: ReturnType<typeof open> | undefined;
  try {
    expect(await a.health()).toEqual({
      ok: false,
      errorCode: "migration_required",
    });
    await a.migrate();
    await a.migrate();
    expect(await a.health()).toEqual({ ok: true });
    await a.acceptInbound(snapshot());
    const legacy = new Database(filename);
    legacy.prepare("DELETE FROM migration_metadata WHERE version=2").run();
    legacy.close();
    expect(await a.health()).toEqual({ ok: false, errorCode: "migration_required" });
    await a.migrate();
    expect(await a.health()).toEqual({ ok: true });
    expect((await a.getInbound("r1"))?.snapshot.text).toBe("question");
    b = open();
    const input = {
      now: 100,
      leaseMs: 10,
      limit: 1,
      leaseOwner: "a",
      safeRetryAccountIds: [],
    };
    const [one, two] = await Promise.all([
      a.takeDue(input),
      b.takeDue({ ...input, leaseOwner: "b" }),
    ]);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(0);
    await a.close();
    a = open();
    expect(await a.takeDue({ ...input, now: 110 })).toEqual([]);
    expect((await a.getInbound("r1"))?.dispatch.status).toBe("unknown");
    const r = required(await a.getInbound("r1"));
    await a.requeue({
      kind: "request",
      id: "r1",
      expectedVersion: r.version,
      now: 111,
      acknowledgeUnknown: true,
    });
    await a.claimRequest({
      requestId: "r1",
      agent: "grok",
      endpointIds: ["ep"],
      claimKey: "attempt",
      claimToken: "durable",
      now: 112,
    });
    await a.close();
    a = open();
    expect(
      await a.claimRequest({
        requestId: "r1",
        agent: "grok",
        endpointIds: ["ep"],
        claimKey: "attempt",
        claimToken: "new",
        now: 1000,
      }),
    ).toMatchObject({ status: "claimed", claimToken: "durable", replay: true });
  } finally {
    await a.close();
    await b?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
