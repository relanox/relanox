# Run and maintain Relanox

Keep Relanox running on a server, retain its database across restarts, and put business HTTP behind HTTPS. [Getting started](getting-started.md) covers account setup; this page covers deployment and maintenance.

## Start with Docker Compose

Install Docker with Compose, clone the repository, and prepare these files from its root:

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
mkdir -p deploy
cp examples/relanox.sqlite.json deploy/relanox.json
```

PowerShell uses `New-Item -ItemType Directory -Force deploy` and `Copy-Item examples/relanox.sqlite.json deploy/relanox.json`.

If you downloaded a configuration, copy that file to `deploy/relanox.json` instead of copying the example.

Edit `deploy/relanox.json` using [Configuration](configuration.md). For the supplied Compose file, set:

- `server.host`: `0.0.0.0`.
- `relay.storage.config.filename`: `/data/relanox.sqlite`.
- `publicUrl`: your public HTTPS origin, such as `https://relay.example.com`.
- Your sender IDs and exact conversation bindings.

Create a protected `.env` file in the repository root with the variables referenced by your config. For Telegram/Grok:

```dotenv
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET=REPLACE_WITH_WEBHOOK_SECRET
RELANOX_AGENT_1_MCP_TOKEN=REPLACE_WITH_MCP_TOKEN
RELANOX_AGENT_1_ROUTINE_URL=REPLACE_WITH_COMPLETE_ROUTINE_URL
RELANOX_AGENT_1_ROUTINE_AUTHORIZATION='REPLACE_WITH_COMPLETE_AUTHORIZATION_VALUE'
```

Replace all placeholders. Follow Compose's quoting syntax for values containing spaces or `$`. Restrict access to the deployment operator; on POSIX systems use `chmod 600 .env`. Keep this file and account configuration out of commits.

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 100 relanox
```

Compose builds a local image, runs the service and restarts it after an unexpected exit. Wait for its health check to become healthy after storage initialization and the first processing batch.

Business HTTP maps to host `127.0.0.1:8787`. The JSON mounts read-only at `/config/relanox.json`; a named volume stores data at `/data`. Management listens on `127.0.0.1:8788` inside the container. Run administration there:

```sh
docker compose exec relanox node dist/main.js doctor --config /config/relanox.json --management-url http://127.0.0.1:8788
docker compose exec relanox node dist/main.js status --config /config/relanox.json --limit 100
```

For WeCom WebSocket chat and sender IDs, stop any running process using the same bot, supply `WECOM_BOT_SECRET`, then run the discovery command below. It can use configuration with incomplete bindings or missing Agent credentials. Send a message to the bot; the command prints only IDs and makes no configuration changes. See [WeCom](channels/wecom.md).

```sh
node apps/cli/dist/main.js discover --config relanox.json --account wecom-main --timeout 120
```

The timeout accepts 1–600 seconds (default 120); press Ctrl+C to stop sooner.

## Give the service an HTTPS address

Point your public domain at the host and use a reverse proxy with a trusted TLS certificate. Caddy on the same host can use this `Caddyfile`:

```caddyfile
relay.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Replace the domain, make TCP ports 80/443 reachable for certificate issuance and HTTPS traffic, and configure Caddy as a service using its installation instructions. A proxy in another container needs a Docker network route to Relanox instead of this host-loopback address.

Preserve the public Host header to match the host in `publicUrl`. Register channel webhook and Agent MCP URLs under the public address. Forward business HTTP and retain management on loopback. [Media transfer](media.md) describes public attachment URLs when your channel needs them.

Grok MCP URLs contain the secret token. Do not share them; disable access logging for `/agents/grok/mcp/` paths or strip their token segment in your reverse proxy logs.

## Stop, restart and upgrade

```sh
docker compose stop relanox
docker compose start relanox
docker compose restart relanox
```

Compose allows 20 seconds to stop; Relanox's default shutdown timeout is 15 seconds. Increase both when you need a longer graceful stop.

Before upgrading, back up the database and configuration. Record the current commit using `git rev-parse HEAD`, then:

```sh
docker compose stop relanox
# Take the backup below before changing the checkout.
git pull --ff-only
docker compose build
docker compose up -d
docker compose exec relanox node dist/main.js doctor --config /config/relanox.json --management-url http://127.0.0.1:8788
```

Send a short message through each configured channel after upgrading. For a source installation, stop the process, back up, update the checkout, run `pnpm install --frozen-lockfile` and `pnpm build`, then start the CLI with the original working directory and environment.

`docker compose down` retains the data volume. Use `docker compose down --volumes` only when you intend to permanently remove that installation's stored messages and state.

## Back up and restore

For SQLite, stop cleanly and back up the entire `/data` directory, including remaining `-wal` and `-shm` files. These PowerShell commands use the supplied Compose deployment:

```powershell
docker compose stop relanox
$backupPath = Join-Path (Get-Location) ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $backupPath | Out-Null
$containerId = docker compose ps -a -q relanox
docker cp "${containerId}:/data/." $backupPath
Copy-Item deploy/relanox.json (Join-Path $backupPath 'relanox.json')
docker compose start relanox
```

Restrict access to backups, which contain conversations, attachments and connection state. Keep a separately protected copy of the environment secrets used by the config.

Test restoration in a separate installation first. Keep it stopped while restoring. For the supplied Compose volume, create a stopped container and copy the database files to `/data`:

```powershell
# Replace with the chosen backup directory.
$restorePath = 'C:/backups/relanox/20261011-120000'
docker compose create relanox
$containerId = docker compose ps -a -q relanox
Get-ChildItem -LiteralPath $restorePath -Filter 'relanox.sqlite*' | ForEach-Object {
  docker cp $_.FullName "${containerId}:/data/"
}
docker compose run --rm --no-deps --user root --entrypoint sh relanox -c 'chown -R node:node /data'
```

Use the actual database filename in the filter if you changed it. Restore into an empty data volume so newer database/WAL files cannot mix with the backup. Restore JSON to `deploy/relanox.json` and secrets separately. Run `docker compose run --rm relanox doctor --config /config/relanox.json` for an offline storage check. Stop the original instance using those live credentials before starting the restored one. Verify readiness and a fresh reply before returning to normal operation.

For PostgreSQL, use consistent database tooling:

```sh
pg_dump --format=custom --file=relanox.dump "$RELANOX_DATABASE_URL"
pg_restore --dbname="$RESTORE_DATABASE_URL" relanox.dump
```

These use POSIX variables; PowerShell uses `$env:RELANOX_DATABASE_URL` and `$env:RESTORE_DATABASE_URL`. Restore into an empty separate database, preserve the configured schema, and update the restored instance's connection string. Managed database backup/restore tools are also suitable.

## Find and recover a stalled message

For source installations, use `node apps/cli/dist/main.js`. Inside Docker:

```sh
docker compose exec relanox node dist/main.js status --config /config/relanox.json --endpoint-id agent-1
```

| State                           | Check                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| No incoming record              | Webhook/connection, sender allowlist, exact chat and thread binding                           |
| Incoming `due`                  | Agent credentials, Routine availability or dot subscription; logs show scheduled retries      |
| Incoming `accepted`, no reply   | Agent plugin connection and whether the Agent has started processing                          |
| Incoming or delivery `rejected` | Correct the reported permission/configuration problem before retrying                         |
| Delivery `pending`              | Platform connection, permissions, retry delay and earlier held deliveries to the same channel |
| Delivery `sent`                 | The platform accepted the reply; check its original chat/topic                                |
| `unknown`                       | Check the Agent or platform for a completed action before repeating                           |

You can ask the Agent to check which chats it can send to and whether a reply was sent. The CLI command above also shows incoming messages and the IDs and versions needed for recovery. Changing the Agent assigned to a chat does not redirect replies already waiting to be sent.

Temporary failures retry automatically. To repeat a retained Agent notification, substitute its `requestId` and current `version` from status:

```sh
docker compose exec relanox node dist/main.js requeue --config /config/relanox.json --kind request --id REQUEST_ID --expected-version 4
```

To resend a retained reply without asking the Agent to answer again, use its `deliveryId` and current `version`:

```sh
docker compose exec relanox node dist/main.js requeue --config /config/relanox.json --kind delivery --id DELIVERY_ID --expected-version 7
```

Use the actual current version. If recovery reports a conflict, read status again before retrying.

For `unknown`, the external action could have completed before its response was lost. Inspect it first. If a repeat is appropriate, add `--acknowledge-unknown`; this can duplicate a reply or repeat Agent work. Restarting retains the record for inspection. Request recovery repeats the original notification; delivery recovery resumes the retained reply.

If you changed bot/app identity, restore its original account settings and credential identity before recovering queued replies. Rotation under the same identity is suitable. Retained messages keep their original destination; use new accounts/Agent connections for new identities.

## Keep only the content you need

Choose a retention interval. To clean eligible completed content older than 30 days in PowerShell:

```powershell
$before = [DateTimeOffset]::UtcNow.AddDays(-30).ToUnixTimeMilliseconds()
docker compose exec relanox node dist/main.js cleanup --config /config/relanox.json --before $before --limit 1000
```

Repeat in batches as needed. Cleanup removes eligible completed message content and old attachments. It keeps unfinished or uncertain replies, files still used by retained messages and recent uploads. Cleaned files can no longer be downloaded or used in new messages. Allow recipients time to download attachments before cleanup, and choose a separate retention period for backups.

## Monitor the installation

Poll local `/health/ready` for readiness and `/health/live` for process health. Docker's built-in check polls readiness; `doctor` also checks environment variables and storage. For centralized monitoring, follow [Logs and service status](reference/observability.md) to collect metrics.

[Prometheus alert examples](https://github.com/relanox/relanox/blob/master/deploy/prometheus-alerts.yml) cover processing and connection health. Install them in your monitoring stack, adjust latency thresholds, and configure alert destinations there. Monitor scrape availability too, so an unreachable process produces an alert.
