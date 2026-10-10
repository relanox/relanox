# Runtime startup regressions

## Concurrent native connection initialization

1. Observable behavior: authenticated, allowlisted, bound WeCom text received while DingTalk is still discovering its connection is durably accepted. The management readiness endpoint remains unavailable until initialization and a successful worker scan finish.
2. Credible regression: setting core acceptance only after all connections start makes the earlier WeCom frame fail with `not_accepting`, causing disconnection and loss on a transport without guaranteed replay.
3. Existing gap: CLI tests cover HTTP ingress after startup, empty/pull databases and listener cleanup; native channel tests start a single channel against an already accepting core. Neither exercises concurrent production CLI starts.
4. Production seams: none added. Native protocol peers emit real WS authentication/heartbeat/message frames and hold the external DingTalk HTTP discovery response. Routing, allowlists, persistence and deduplication remain production core/SQLite. The existing management listener and explicit protocol-loopback options are used.

## Persisted first batch, readiness and shutdown

1. Observable behavior: startup returns while the first persisted Grok notification is awaiting an external receipt, even when the configured startup timeout is shorter than that valid provider wait. Readiness stays false before the first settled batch. Shutdown waits for the active call and durable settlement and does not launch another overlapping batch.
2. Credible regression: awaiting the entire first scan subjects normal backlog processing to the connection-startup timeout; forgetting the active promise during asynchronous launch allows storage to close before settlement or schedules overlapping scans.
3. Existing gap: all CLI startup coverage begins with an empty or pull-only database, so the first scan returns immediately. Existing core retry tests do not own the resident worker or process lifecycle.
4. Production seams: none added. Seed a real SQLite request through its public storage API as restart state. A real HTTP peer records the Routine POST and holds/releases only the external HTTP response; it never implements Relanox authorization, routing, claims, settlement or retries. Tests use public startRuntime and management APIs, plus real storage reads.

## First background scan failure and recovery

1. Observable behavior: a real SQLite contention failure in a background scan keeps readiness false, does not reject startup or leak an unhandled rejection, and later scans recover after the external database lock is released.
2. Credible regression: launching a rejected scan without containment produces an unhandled rejection; stamping health before successful settlement hides failure; not scheduling after failure prevents recovery.
3. Existing gap: existing CLI startup tests only use healthy SQLite after migration; core tests check normalized storage failures without running the resident scheduling loop.
4. Production seams: use a second real SQLite connection holding a write lock with `BEGIN IMMEDIATE`, and configure the runtime's supported SQLite busy timeout to bound the failure. No fake storage, dependency or injection hook is added.
