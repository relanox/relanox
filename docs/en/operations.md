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

Metrics use a bounded `plugin` label. Dispatch, delivery, retry and preparation
counters update on actual work. Queue gauges include the oldest pending age,
the most recent successful worker operation and whether storage statistics are
stale; a failed statistics refresh preserves the last values and marks them stale.

```sh
relanox doctor --config relanox.json --management-url http://127.0.0.1:8788 --json
relanox status --config relanox.json --limit 50 --json
```

Operational commands (`validate`, `doctor`, `status`, `requeue`, `cleanup`,
`discover` and `wechat-login`) default to JSON; use `--json=false` for text.
Explicit `--json` also disables interactive prompts. Doctor lists missing
environment/file credential references and checks an existing database without
connecting channels. Status includes request `reply`, delivery `reply` and
`dueAt`. Request and delivery timestamps use Unix milliseconds. Filters include `--endpoint-id`,
`--dispatch-status`, `--delivery-status` and `--after-id`. Both lists use ascending
record-ID order on every page. To page through one list, pass its last ID as
`--after-id` and read that list from the next response; the cursor also filters the
other list independently. Text is included only
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

Both requests and deliveries with an unknown outcome require
`--acknowledge-unknown`, which explicitly accepts possible duplication. A stale
version is rejected. Use `request` for incoming work and `delivery` for outgoing
records. `prepare` is also accepted for incoming work, but retains existing
preparation results; it does not force completed speech recognition to run again.
Pending native consent/passive callbacks do not consume the send retry budget.
Sends within a conversation follow durable enqueue order, including messages
accepted in the same millisecond. Platform-requested retry delays are preserved;
automatic exponential backoff without such a delay is capped at five minutes.

## Retention and backups

While running, the maintenance worker checks retention every minute using
`queue.retentionDays` (30 days by default), with a batch limit of 100 per cleanup
category. The administrative command can use an explicit cutoff and batch size:

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
consistent database backup. Keep a recoverable backup before changing the schema.

SIGINT/SIGTERM disables new acceptance, cancels native connections and workers,
drains HTTP handlers and closes storage after work has joined. The process waits
up to `http.shutdownTimeoutSeconds` (15 seconds by default); a request already transmitted can still have an
unknown outcome. Use a service manager to restart a failed long-running process.
