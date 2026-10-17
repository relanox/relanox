# Operations

Relanox keeps accepted input, preparation results, outbound plans, media and
scoped component state in SQLite or PostgreSQL. It does not need local transcript
files or in-memory queues to recover accepted work.

## Health and observability

The management listener must bind to loopback. Its defaults and routes are:

| Address | Purpose |
| --- | --- |
| `http://127.0.0.1:8788/health/live` | The HTTP process is responding. |
| `http://127.0.0.1:8788/health/ready` | The runtime accepts work, storage is healthy and workers have not failed. |
| `http://127.0.0.1:8788/metrics` | Prometheus metrics when enabled. |

These routes are separate from the public callback/MCP listener. Operational logs
use bounded fields and omit message content, credentials and request headers.
Optional OTLP traces propagate through native ingress, queued work and agent tool
calls. Native connection availability remains distinct from HTTP process health.

```sh
relanox doctor --config relanox.json --management-url http://127.0.0.1:8788 --json
relanox status --config relanox.json --limit 50 --json
```

Doctor checks configuration, credential availability and an existing database; it
does not connect channels. Status filters include `--endpoint-id`,
`--dispatch-status`, `--delivery-status` and `--after-id`. Text is included only
with `--include-content`. Native private reply targets and captured credentials
are excluded even when content is requested. Administrative inspection does not
create an absent database or initialize an empty schema.

## Unknown outcomes and replay

Relanox distinguishes rejection, retryable failure and an unknown remote effect.
If a process stops after a request may have reached an external service, blind
replay can duplicate the action. Native operations with durable idempotency can
recover automatically; a short-lived nonce alone is insufficient.

Use the record ID and current version printed by status:

```sh
relanox requeue --kind request --id REQUEST_ID --expected-version VERSION --json
relanox requeue --kind delivery --id DELIVERY_ID --expected-version VERSION \
  --acknowledge-unknown --json
```

The second command explicitly acknowledges possible duplication of an unknown
effect. A stale version is rejected. `prepare` can select durable preparation
work; ordinary requests use `request` and outbound records use `delivery`.
Pending native consent/passive callbacks do not consume the send retry budget.

## Retention and backups

```sh
relanox cleanup --before 2026-10-01T00:00:00Z --limit 1000 --json
```

Cleanup redacts completed records and removes unreferenced retained media within
bounded batches. It preserves durable deduplication/final-reply identity and
pending or ambiguous work. The limit applies to storage cleanup categories, not
a global estimate of total rows changed. Unix milliseconds are also accepted.

Back up the configuration, all referenced credential files, Muse pairing
directories and the database together. For SQLite, stop Relanox before copying its
database files, or use a database-aware backup procedure. For PostgreSQL, use a
consistent database backup. Preserve the old database before any migration.
TypeScript databases require an explicit migration; the Go runtime refuses them.

SIGINT/SIGTERM disables new acceptance, cancels native connections and workers,
drains HTTP handlers and closes storage after work has joined. The process waits
up to its shutdown deadline; a request already transmitted can still have an
unknown outcome. Use a service manager to restart a failed long-running process.
