# Operations

Relanox is one resident Node 24 process with one authoritative SQLite or PostgreSQL database. Back up the configuration and database before upgrades. Real platform accounts remain experimental; the repository verifies documented protocols with local peers.

## Container deployment

The Dockerfile builds the workspace and deploys only CLI production dependencies. It runs as UID 1000, with a writable `/data` volume. The pinned Node 24.21.0 Debian image includes the Linux native runtime required by SQLite. No host `node_modules` or reference repositories enter the build context.

1. Copy `.env.example` to `.env` and `deploy/empty.example.json` to `deploy/relanox.json`.
2. Replace the empty account, endpoint and binding arrays with your selected configuration from [CLI examples](CLI.md). The empty configuration only checks installation; it cannot relay messages. Set referenced credentials in `.env`.
3. Run `docker compose build`, then `docker compose run --rm relanox validate --config /config/relanox.json`.
4. Run `docker compose run --rm relanox migrate --config /config/relanox.json` explicitly.
5. Run `docker compose up -d`; inspect `docker compose ps` and `docker compose logs --tail 100`.

Compose publishes business HTTP on host `127.0.0.1:8787`. Terminate public HTTPS in your reverse proxy and forward the exact `/channels/<account>/...` and `/agents/<kind>/...` routes documented by the selected plugin. Long-connection plugins need outbound access. Do not add request bodies, Authorization headers or secret query parameters to proxy logs.

The management listener stays on container `127.0.0.1:8788`; it is not published. The image health check requests `/health/ready`. If you change that port, override the health check as well. `/health/live` reports process acceptance, `/health/ready` also checks storage, connections and worker freshness, and `/metrics` exposes Prometheus metrics when standard observability is enabled. Scrape from the same network namespace, for example a monitoring sidecar sharing the service's network, or through an explicitly authenticated local proxy. Do not expose management endpoints publicly.

An unmigrated database prevents startup. Startup does not perform migrations. Stop the running relay before upgrades, take a backup, rebuild, migrate explicitly, then start and verify readiness. Compose allows 20 seconds for shutdown against the CLI's default 15-second shutdown budget. Increase both together if needed. `docker compose down` preserves the named volume; `down --volumes` deletes it.

## Storage and recovery

SQLite uses WAL. For an offline backup, stop Relanox cleanly and copy the entire data directory, including any remaining WAL/SHM files. Do not copy only the main file while writes are active. For PostgreSQL, use the server's consistent backup tooling and preserve the configured schema. Restore into a separate test instance first; never run two restored copies against the same live channel credentials while assessing recovery.

`status` and `doctor` show operational state without message bodies by default. A long-lived claimed request remains claimed after restart; restarting does not authorize a second remote execution. A known transient delivery failure follows the persisted retry schedule. An ambiguous external send remains `unknown` unless that channel declares sufficient idempotency. Before explicitly requeueing an unknown send, inspect the platform conversation and accept the duplicate-send risk using the CLI's required acknowledgment. Requeueing delivery does not rerun the agent. Request requeue revokes the old claim token.

Retention removes/redacts eligible terminal data only. Pending requests and undelivered results are preserved. Schedule the explicit `cleanup` command according to your retention policy; retain backups securely because they may contain message text and protocol state. Secret environment references are retained in snapshots, so referenced secrets must still be available when old requests resume.

## Verification boundary

CI tests real SQLite and PostgreSQL, documented HTTP/socket peers, and the final Docker image. The image test checks explicit migration, non-root execution, health and restart against a persistent volume. These checks do not validate live account permissions, public DNS/TLS, platform review requirements or production availability guarantees.
