# Send your first message

Connect a Telegram bot to a Grok Bot, send a message, and receive the answer in the same chat. For dot, follow [Connect an agent](agents.md) after installing Relanox.

## 1. Prepare your accounts

Have these ready:

- A Telegram bot token from BotFather, your user ID and the destination chat ID. For a private conversation, the chat ID is normally your user ID. See [Telegram](channels/telegram.md) for groups and topics.
- A Grok Bot with a webhook-triggered Routine, its complete webhook URL and Authorization value, and an MCP connection.
- A machine that can keep Relanox running and a public HTTPS address, such as `https://relay.example.com`. [Operations](operations.md) shows a reverse proxy setup.
- Git, Node.js 26.11.1 and pnpm 12.11.2 for the source installation below. [Operations](operations.md) also covers Docker.

For manual setup, create independent random secrets for Telegram's webhook and Grok's MCP connection. Generate each separately and keep it in your secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 2. Install and prepare the configuration

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

If you used the [connection configurator](connect.md), keep its downloaded `relanox.json` in the repository root and follow its generated guide. The Telegram/Grok commands below match the manual example. For manual setup, copy the example in PowerShell:

```powershell
Copy-Item examples/relanox.sqlite.json relanox.json
```

On Linux/macOS use `cp examples/relanox.sqlite.json relanox.json`. Edit `relanox.json`:

| Location                           | Your value                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `relay.accounts[0].allowedSenders` | Your Telegram user ID as a string, for example `["123456789"]`                                |
| `relay.bindings[0].chatId`         | The exact Telegram chat ID as a string                                                        |
| `publicUrl`                        | Your public HTTPS origin, for example `https://relay.example.com`; include a non-default port |
| `relay.storage.config.filename`    | Your database path; the example uses `relanox.sqlite` in the launch directory                 |

Keep `telegram-main` and `agent-1` for the URLs below. Keep `server.host` as `127.0.0.1` for a reverse proxy on the same host; use `0.0.0.0` inside a container.

## 3. Supply the environment variables

For generated configuration, supply the exact environment names and values shown by the configurator. This table matches the manual Telegram/Grok example.

| Variable                                | Value                                                  |
| --------------------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`                    | BotFather's token                                      |
| `TELEGRAM_WEBHOOK_SECRET`               | Your random Telegram webhook secret                    |
| `RELANOX_AGENT_1_MCP_TOKEN`             | Your separate random MCP token, as a raw token         |
| `RELANOX_AGENT_1_ROUTINE_URL`           | Complete Routine webhook URL                           |
| `RELANOX_AGENT_1_ROUTINE_AUTHORIZATION` | Complete Authorization value supplied for that Routine |

Prompt for the values in PowerShell so they stay out of literal command history:

```powershell
foreach ($name in @('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'RELANOX_AGENT_1_MCP_TOKEN', 'RELANOX_AGENT_1_ROUTINE_URL', 'RELANOX_AGENT_1_ROUTINE_AUTHORIZATION')) {
  $value = Read-Host $name -AsSecureString
  [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $value).Password, 'Process')
}
```

For a service, supply these variables through its protected environment settings. Docker uses the `.env` file in [Operations](operations.md). A source-run process reads its shell environment; supply the variables before starting it. Relanox does not automatically load `.env` files.

## 4. Start Relanox

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
```

Validation reports `ok: true` and the account/agent counts. Starting creates the database tables and prints a `started` event with the listener addresses. Leave the terminal running.

In another terminal, supply the same environment variables and run:

```sh
node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
```

Wait until `ok` is `true`. Start the service before checking a fresh database: startup initializes storage, and readiness becomes healthy after the first successful processing batch.

## 5. Connect Telegram and Grok

Configure your HTTPS reverse proxy to forward to `http://127.0.0.1:8787`, preserving the public Host header. In the PowerShell shell holding your secrets, replace the public address and register Telegram's webhook:

```powershell
$publicUrl = 'https://relay.example.com'
$body = @{
  url = "$publicUrl/channels/telegram-main/webhook"
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType 'application/json' -Body $body
```

Telegram should return `ok: true`. Keep tokens out of shared screenshots and output.

Add an MCP connection to your Grok Bot:

- URL: `https://relay.example.com/agents/grok/mcp/agent-1/<URL-encoded-RELANOX_AGENT_1_MCP_TOKEN>`.
- Authentication: no additional authentication; the example sets `mcp.auth` to `path`, so no Authorization header is required.

Configure the Routine to use that bot. Relanox provides reply guidance through the MCP connection; no separate reply prompt is needed. See [Connect an agent](agents.md). Check its URL and Authorization against the environment variables. Restart Relanox after editing its configuration or deployment environment.

## 6. Receive your first reply

Start a private conversation with the Telegram bot and send `Hello, please reply with a short greeting.` from the allowed user in the bound chat. Grok calls `relanox_send_message`, and Relanox returns its answer to Telegram.

```sh
node apps/cli/dist/main.js status --config relanox.json --endpoint-id agent-1
```

An incoming request marked `accepted` means the Routine accepted the notification. An outgoing delivery marked `sent` means Telegram accepted the reply. If only the incoming record appears, check Grok's MCP connection and Routine execution; refresh the connection after updating Relanox. If no incoming record appears, check the webhook, user ID and chat binding. [Operations](operations.md#find-and-recover-a-stalled-message) covers other states and recovery.

Add more conversations with [Configuration](configuration.md), choose a platform in [Channels](channels/index.md), and set up attachments with [Media transfer](media.md).
