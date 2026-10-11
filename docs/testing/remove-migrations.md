# Automatic schema initialization

## Storage initialization and restart

1. Observable behavior: initialize creates an empty SQLite/PostgreSQL schema idempotently; repeating initialization after storing work or reopening preserves accepted text, leases, claims and permanent state deletion fences. Health only inspects tables.
2. Credible regression: startup skips schema creation, repeated creation clears records, or initialization resurrects deleted state versions.
3. Existing gap: existing tests demand a version upgrade command and metadata fixtures; they do not protect the unreleased project startup contract. Replace those requirements with initialization and retain independent connection/restart and shared ABA cases. Fixture-only callers switch to initialize without changing business assertions.
4. Production seams: none. Runtime calls the public initialize method; real storage APIs and database files/pools protect durable outcomes.

## CLI startup and offline diagnosis

1. Observable behavior: doctor and status inspect an empty database without creating tables; actual run initializes it, reaches readiness, and preserves an accepted record across process restart. Existing listener and recovery tests use normal runtime initialization or the SDK method.
2. Credible regression: offline diagnosis writes tables, run refuses a new installation, or restart clears persistent work.
3. Existing gap: prior CLI tests required an explicit command before run and never demonstrated first startup with a blank file. Replace that coherent case and remove command setup from runtime cases; recovery fixture uses the public initialization method.
4. Production seams: none. Actual CLI subprocesses, production runtime, SQLite storage and public health/status endpoints are used.

## Production container startup

1. Observable behavior: the production image initializes the mounted empty volume during ordinary startup, runs as UID 1000, becomes ready and remains ready after restart.
2. Credible regression: deploy packaging misses initialization or native SQLite dependencies, startup cannot write the volume, or repeated startup corrupts the schema.
3. Existing gap: the prior container case required a preparatory command and could not prove normal first startup. Update it to directly start the image on the empty volume and retain restart and privilege assertions.
4. Production seams: none. Docker runs the built production entrypoint with its persistent volume.

## Worker recovery with automatic startup initialization

1. Observable behavior: a first worker scan blocked by a real SQLite write lock makes readiness unavailable until the lock is released, then the resident worker recovers.
2. Credible regression: startup reports ready before a successful scan or permanently stops after the first lock error.
3. Existing gap: the original fixture acquired the lock before schema setup, which now correctly blocks initialization instead of reaching the worker; hold an external channel discovery response until initialization has finished, then acquire the lock before the first scan.
4. Production seams: none. Existing native protocol peer, actual SQLite lock subprocess, runtime and HTTP readiness are used.

## Validation

`pnpm build`, `pnpm format`, `pnpm lint` and `pnpm typecheck` pass. Full Vitest with the real local PostgreSQL server passes 405 tests across 29 files; the production container case is the sole local skip because no image/daemon is supplied. Actual built CLI first startup and restart use a new SQLite file, retain the accepted request and expose readiness. Existing independent storage connection/restart and tombstone ABA regressions remain in the full suite. No real platform accounts are tested.
