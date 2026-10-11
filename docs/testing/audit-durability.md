# Durability review regressions

## Unknown notification metrics after an authenticated claim

1. Observable behavior: an uncertain notification counts as unknown while the request remains pending. Once the agent durably claims it, the request is known to have reached processing; claiming, completion or failure must not leave a permanent recovery alert. An independently unknown outbound delivery still counts.
2. Credible regression: both storage aggregate queries count historical `dispatch.status = unknown` even after claim and finalization. A timed-out notification that the agent later processes therefore leaves `relanox_unknown` nonzero forever, including after successful delivery, and recommends unnecessary recovery of completed work.
3. Existing gap: current shared tests cover unknown lease recovery and general aggregates separately; none checks aggregate transitions when an agent claims a previously uncertain notification without requeueing it.
4. Production seams: none. The shared contract uses real SQLite and PostgreSQL through their public storage APIs, real lease settlement, claims, finalization and outbound settlement. Expected counts are literal business outcomes.

## Shutdown drains the active effect without leasing more work

1. Observable behavior: shutdown waits for an already started external notification to settle, but leaves another endpoint's untouched due request pending for the next process. Restart sends that second request once.
2. Credible regression: stopping the CLI timer does not stop the current core batch loop. After the in-flight effect settles, it leases and sends additional work while plugins and listeners are being stopped, consuming the shutdown budget and risking avoidable uncertain effects.
3. Existing gap: the existing shutdown test seeds only one due request, so it cannot observe the batch starting more effects after shutdown. Extend it with a second endpoint and verify persisted state before restart.
4. Production seams: none. Use production CLI/core, the existing real SQLite fixture and a local HTTP Routine peer that holds only the external response; inspect real durable records and requests.

## State delete/recreate fences

1. Observable behavior: deleting and recreating the same plugin state key must invalidate old versions permanently. Reads and lists hide deleted entries; a legitimate active entry with JSON null as its value remains visible.
2. Credible regression: physical deletion resets recreated keys to version 1. A delayed dot callback holding version 1 can delete a newly re-established subscription after unsubscribe/subscribe, or stale CAS can replace its signing secret.
3. Existing gap: shared tests check mismatched versions on one live entry but never recreate a deleted key; dot's renewal test advances an existing version rather than deleting it. Add shared real-database coverage; the agent audit adds the HTTP/MCP race regression separately.
4. Production seams: none. Public state get/list/CAS/delete methods on real SQLite/PostgreSQL expose stale mutations and null-value semantics. An internal null-record tombstone retains only the version fence, not the deleted value.
