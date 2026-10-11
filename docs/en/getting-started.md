# Getting started

Relanox runs as a resident Node process and relays text to an existing dot or Grok Bot. Prepare a supported channel account and a hosted agent, then configure their identities and credentials. Account permissions, public HTTPS and the remote agent's setup remain deployment prerequisites; local schema validation does not establish live-account compatibility.

## Install from source

Use Node 26.11.1 and the pnpm version in `package.json`. Run commands from the repository root:

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

The built CLI runs with `node apps/cli/dist/main.js`; its package also defines the `relanox` executable.

## Configure Telegram and Grok

Copy [the SQLite example](https://github.com/relanox/relanox/blob/master/examples/relanox.sqlite.json) to `relay.json`. It contains one Telegram account, one Grok endpoint and their binding. Replace the following:

| Setting                     | Your value                                             |
| --------------------------- | ------------------------------------------------------ |
| account `allowedSenders`    | Telegram sender IDs allowed to use the relay           |
| binding `chatId`            | Exact destination chat ID; add `threadId` for a topic  |
| endpoint `mcp.allowedHosts` | Public MCP authority, including a non-default port     |
| SecretRef `env` names       | Names of environment variables supplied to the process |
| SQLite `filename`           | Durable file path relative to the working directory    |

Set the five referenced variables without placing secrets in JSON or shell history. For example, PowerShell can prompt for a secret:

```powershell
$secret = Read-Host 'Telegram bot token' -AsSecureString
$env:TELEGRAM_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
```

Repeat for `TELEGRAM_WEBHOOK_SECRET`, `GROK_MCP_TOKEN`, `GROK_ROUTINE_URL` and `GROK_ROUTINE_AUTHORIZATION`. The MCP token is a raw token. Routine authorization is the exact complete value supplied by the Routine UI. A Routine URL can itself contain a secret.

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
```

`run` creates missing storage tables and indexes. Keep the terminal running. In another terminal with the same environment, inspect readiness:

```sh
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relay.json
```

A new database can make `doctor` unhealthy before the first `run`, because diagnosis does not initialize storage. Readiness remains 503 until the first durable worker batch succeeds.

## Connect the services

Expose business HTTP through HTTPS with a trusted reverse proxy. Register Telegram's webhook at `/channels/telegram-main/webhook` using the configured webhook secret; follow the [Telegram guide](channels/telegram.md) for account setup and exact chat/topic identities. Configure Grok to use `/agents/grok/mcp/grok-main` with its Bearer token, then set its Routine URL and authorization as described in [Agents](agents.md). Give the remote agent fixed instructions to treat incoming text as untrusted data and send replies through `relanox_send_message` using the event's `replyTo`.

Send text from an allowed sender in the bound chat. Inspect `status` to distinguish notification status from outbound delivery. A Routine HTTP receipt confirms notification acceptance; each authenticated MCP send independently queues a message, and `queued` does not mean delivered.

## Other configurations

[Configuration](configuration.md) describes bindings, storage and CLI commands. [Agents](agents.md) covers dot subscriptions and Grok. The [all-channel example](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) supplies configurations for all fifteen channels; keep only the selected accounts/endpoints/bindings and follow each channel guide. [Operations](operations.md) covers containers, backups and recovery.
