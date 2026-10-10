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
2. Credible regression: launching a rejected scan without containment produces an unhandled rejection; stamping health before successful settlement hides failure; not scheduling after failure prevents recovery. A same-process fixture using both Node's SQLite and better-sqlite3 can bypass the intended contention on POSIX platforms because the separately linked SQLite libraries do not share connection tracking.
3. Existing gap: existing CLI startup tests only use healthy SQLite after migration; core tests check normalized storage failures without running the resident scheduling loop.
4. Production seams: an independent Node process opens the real database with `node:sqlite`, holds a write lock with `BEGIN IMMEDIATE`, then signals successful acquisition over IPC before runtime startup. It rolls back and exits on the release message or IPC disconnect; the parent bounds acquisition/shutdown waits and terminates a stuck peer. The runtime's supported SQLite busy timeout bounds the actual scan failure. Separating processes makes OS file-lock contention effective on Windows and POSIX without mixing two SQLite copies inside one process. The peer only owns an external database transaction, never Relanox routing, settlement or retry behavior. No fake storage, dependency or production injection hook is added. SQLite documents the POSIX and separately linked library caveat in [file locking problems](https://sqlite.org/howtocorrupt.html#_multiple_copies_of_sqlite_linked_into_the_same_application).
