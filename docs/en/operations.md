# Operations

Relanox is one resident Node 26 process with one authoritative SQLite or PostgreSQL database. Back up the configuration and database before upgrades.

## Container deployment

The Dockerfile builds the workspace and deploys only CLI production dependencies. It runs as UID 1000, with a writable `/data` volume. Both stages pin the Node 26.11.1 Debian image by digest. SQLite ships its native binary in the installed package. No host `node_modules` or reference repositories enter the build context.

1. Copy `.env.example` to `.env` and `deploy/empty.example.json` to `deploy/relanox.json`.
2. Replace the empty account, endpoint and binding arrays with your selected configuration from [CLI examples](configuration.md). The empty configuration only checks installation; it cannot relay messages. Set referenced credentials in `.env`.
3. Run `docker compose build`, then `docker compose run --rm relanox validate --config /config/relanox.json`.
4. Run `docker compose up -d`; inspect `docker compose ps` and `docker compose logs --tail 100`.

Compose publishes business HTTP on host `127.0.0.1:8787`. Terminate public HTTPS in your reverse proxy and forward the exact `/channels/<account>/...` and `/agents/<kind>/...` routes documented by the selected plugin. Long-connection plugins need outbound access. Do not add request bodies, Authorization headers or secret query parameters to proxy logs.

The management listener stays on container `127.0.0.1:8788`; it is not published. The image health check requests `/health/ready`. If you change that port, override the health check as well. `/health/live` reports process acceptance, `/health/ready` also checks storage health and worker freshness; individual channel connection state is reported separately through metrics, and `/metrics` exposes Prometheus metrics when standard observability is enabled. Scrape from the same network namespace, for example a monitoring sidecar sharing the service's network, or through an explicitly authenticated local proxy. Do not expose management endpoints publicly.

Startup creates missing tables and indexes automatically, preserving existing work. Stop the running relay before replacing the binary, take a backup, rebuild, then start and verify readiness. Compose allows 20 seconds for shutdown against the CLI's default 15-second shutdown budget. Increase both together if needed. `docker compose down` preserves the named volume; `down --volumes` deletes it.

## Storage and recovery

SQLite uses WAL. For an offline backup, stop Relanox cleanly and copy the entire data directory, including any remaining WAL/SHM files. Do not copy only the main file while writes are active. For PostgreSQL, use the server's consistent backup tooling and preserve the configured schema. Restore into a separate test instance first; never run two restored copies against the same live channel credentials while assessing recovery.

`status` and `doctor` show operational state without message bodies by default. A long-lived claimed request remains claimed after restart; restarting does not authorize a second remote execution. A known transient delivery failure follows the persisted retry schedule. An ambiguous external send remains `unknown` unless that channel declares sufficient idempotency. Before explicitly requeueing an unknown send, inspect the platform conversation and accept the duplicate-send risk using the CLI's required acknowledgment. Requeueing delivery does not rerun the agent. Request requeue revokes the old claim token.

Retention removes/redacts eligible terminal data only. Pending requests and undelivered results are preserved. Schedule the explicit `cleanup` command according to your retention policy; retain backups securely because they may contain message text and protocol state. Secret environment references are retained in snapshots, so referenced secrets must still be available when old requests resume.

An endpoint snapshot freezes the configured SecretRef name, not its resolved value. In particular, a Grok Routine URL is itself secret-bearing and is resolved from its environment variable at dispatch. Do not repurpose that variable for a different Routine while requests are pending; use a new environment variable and endpoint configuration for a new destination. Credential rotation under the same reference is deliberate, and resolved credentials are never persisted to freeze them.

## Monitoring

Prometheus rule examples are in [deploy/prometheus-alerts.yml](https://github.com/relanox/relanox/blob/master/deploy/prometheus-alerts.yml). Adjust thresholds to the expected duration of your hosted agents and configure notification routing in your monitoring stack. Connection status is aggregated per channel plugin across its configured accounts; it is separate from service readiness. Monitor scrape availability (`up`) separately so a stopped process is distinguishable from stale or missing metrics. These examples do not install a monitoring service.

Platform account permissions, public DNS/TLS and platform review requirements must be configured for each deployment.

## Transport and frozen identities

Credentials stay in SecretRefs. Redirects are refused. Cleartext transports require the selected plugin's explicit loopback option and a loopback address it permits (some channels also permit localhost; dot/Grok require literal loopback addresses); do not substitute a remote insecure endpoint.

A delivery target freezes its channel identity. If the current bot/app/service identity differs, restore the original configuration and credential identity before explicitly recovering the retained delivery. A legacy target missing required frozen identity cannot be repaired by adopting the current identity: inspect the original destination and deliver manually if necessary. Never rewrite durable target identity merely to make a send pass. Unknown effects are never automatically replayed without declared safe idempotency; recovery still requires the current version and acknowledgment.
