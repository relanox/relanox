# Send your first message

Connect a Telegram bot to a Grok Bot, send a message, and receive the answer in the same chat. For dot, follow [Connect an agent](agents.md) after installing Relanox.

## 1. Prepare your accounts

Have these ready:

- A Telegram bot token from BotFather, your user ID and the destination chat ID. For a private conversation, the chat ID is normally your user ID. See [Telegram](channels/telegram.md) for groups and topics.
- The Grok Bot desktop app, signed in with your paid Cursor account. You will create its webhook Routine below.
- A machine that can keep Relanox running and a public HTTPS address, such as `https://relay.example.com`. [Operations](operations.md) shows a reverse proxy setup.
- Git, Node.js 26.11.1 and pnpm 12.11.2 for the source installation below. [Operations](operations.md) also covers Docker.

## 2. Install and prepare the configuration

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

The source installation includes all native plugins as workspace development dependencies; no separate plugin installation is needed for this flow. Independently installed packages and local development overrides are described in [Configuration reference](reference/configuration.md#install-and-load-native-plugins).

Open the [connection configurator](connect.md). Enter your public HTTPS address, change the default Agent from dot to Grok, and enable Telegram. Fill in your allowed Telegram user ID and private chat ID, then select your Grok Agent for that chat. Keep the generated environment variable names and download `relanox.json` to the repository root.

The generated SQLite database is `relanox.sqlite` in the directory where you run the CLI. Keep that file when restarting or backing up the service.

Open **Your setup guide** and save the generated MCP password before closing or reloading the page. Complete any draft warnings. The guide lists the variables and connection addresses for your choices. For manual setup using the shipped example, see [Configuration reference](reference/configuration.md).

Before setting the environment variables, create the Grok Routine. In the Bot conversation that should answer your Telegram messages, ask:

> Create a routine triggered only by a webhook. Process incoming user messages using the Relanox MCP instructions. Do not add a schedule.

Click the Bot name and open **Details → Routines**, then open the new Routine. Copy **POST to** from its **Webhook** section as the Routine URL. Its Authorization value is `Bearer <key>`; remove the `Authorization:` label if you copy the displayed header. Keep these values for the next step.

## 3. Supply the environment variables

Supply every variable listed in your generated guide. Use BotFather's bot token, a separate random Telegram webhook secret, the generated MCP password, and Grok's complete Routine URL and Authorization value. Generate the webhook secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The following PowerShell command uses the configurator's default names for one Telegram account and one Grok Agent. If you renamed a variable or added an Agent, use the exact names listed in your guide.

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

Validation reports `ok: true` and the account/agent counts. Starting prints a `started` event. Leave the terminal running.

In another terminal, supply the same environment variables and run:

```sh
node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
```

Wait until `ok` is `true`. Run this check after starting the service.

## 5. Connect Telegram and Grok

Follow [Deployment and daily use](operations.md) to make your public HTTPS address reachable. Copy the Telegram callback address from **Your setup guide** into `$webhookUrl` below. Run this command in the PowerShell shell holding your secrets to register the webhook:

```powershell
$webhookUrl = 'https://relay.example.com/channels/telegram-main/webhook'
$body = @{
  url = $webhookUrl
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType 'application/json' -Body $body
```

Telegram should return `ok: true`. Keep tokens out of shared screenshots and output.

Connect the Routine you created in step 2 to Relanox. In the same Cursor account's dashboard, open **Plugins & MCPs → Add → Custom MCP**. Keep **URL** selected and paste the complete Grok MCP address from **Your setup guide** into **Server URL**. Leave **HTTP headers**, **Client ID** and **Client Secret** empty, then click **Add MCP**. In Grok Bot, open **Connect apps → Your plugins** and confirm the connection is ready. See [Connect Grok](agents.md#connect-grok) for details.

Restart Relanox after changing its configuration or environment.

## 6. Receive your first reply

Start a private conversation with the Telegram bot and send `Hello, please reply with a short greeting.` from the allowed user in the bound chat. The answer should arrive in that same Telegram chat.

```sh
node apps/cli/dist/main.js status --config relanox.json --endpoint-id agent-1
```

An incoming request marked `accepted` means the Routine accepted the notification. An outgoing delivery marked `sent` means Telegram accepted the reply. If only the incoming record appears, check Grok's MCP connection and Routine execution. If no incoming record appears, check the webhook, user ID and chat binding. [Operations](operations.md#find-and-recover-a-stalled-message) covers other states and recovery.

Add more conversations with [Configuration](configuration.md), choose a platform in [Channels](channels/index.md), and set up attachments with [Media transfer](media.md).
