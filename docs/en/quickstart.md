# Send your first message

Build Relanox with Go 1.27.2, configure one native account and one hosted agent,
then bind their exact conversation IDs. The service uses a durable queue and
requires a machine that can keep its connections and workers running.

## Before you start

For a first connection, use one channel, one hosted Agent and one conversation.
Prepare a bot/account with the permissions listed in [Native channels](channels.md),
your own sender ID, the exact conversation ID, and an existing
[dot, Grok Bot or Muse account](agents.md). Relanox does not create those accounts.
Your Agent needs a public HTTPS address to reach Relanox, even if the channel uses
polling or a socket. A local-only HTTP listener is not enough.

## Build the current checkout

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
go build -trimpath -o bin/relanox ./cmd/relanox
```

On Windows, use `-o bin/relanox.exe`. Prebuilt binary artifacts and container
commands are described in [Deployment](deployment.md).

## Create the configuration

Choose one of these paths:

- **Guided CLI setup:** follow the `init` and `setup` commands below. The wizard
  saves credentials in private files and prints the connection URLs.
- **Browser configurator:** choose accounts, Agents and bindings in the
  [connection configurator](connect.md), complete its required fields, download
  `relanox.json`, then open its **Setup guide**. Set the listed environment
  variables or secret files on the machine running Relanox. The JSON contains
  references, not the credentials themselves. Continue at **Validate and run** below; do not run `init` over your downloaded configuration.

Choose a public HTTPS origin for native callbacks and MCP, such as
`https://relay.example.com`. Terminate TLS at a reverse proxy and forward the
original Host header to the application listener.

```sh
bin/relanox init --config relanox.json --public-url https://relay.example.com
bin/relanox setup --config relanox.json
```

The wizard asks for a native channel, its credentials, allowed sender IDs, a hosted
agent, and the conversation to bind. WeChat opens its native QR pairing flow and
saves the confirmed bot, user and token automatically. Google Chat imports a
service account JSON file. Muse uses an existing paired credentials directory.
The wizard prints the MCP and native callback URLs needed to finish connecting
the external applications.

Credentials are stored in separate private files beside the configuration. A
nonempty environment override takes precedence over the file. Configuration edits
create a backup and reject concurrent changes. See [Configuration](configuration.md)
for scripted commands and the JSON format.

## Validate and run

```sh
bin/relanox validate --config relanox.json
bin/relanox run --config relanox.json
```

`validate` is offline: it does not open storage or contact accounts. `run` creates
the configured SQLite database, or initializes its tables in an empty existing
PostgreSQL database/schema, then starts
the selected native components. Existing incompatible databases are refused.
Create a non-default PostgreSQL schema before selecting it in configuration.

Keep `run` active while you complete the external connections below.

## Connect the external applications

For Telegram, create a bot with BotFather, supply its token and your numeric user
ID, and configure the bot's `setWebhook` URL using the printed callback address.
Use the generated `webhookSecret` value as Telegram's `secret_token`; it is stored
in the account's credential reference. The native channel does not register a
webhook on your behalf. Other webhook platforms need their corresponding console
configuration. See [Native channels](channels.md).

For dot, add the printed MCP URL to the host's connector settings and complete
OAuth using the generated endpoint credential. For Grok, create a Routine with a
webhook trigger, supply its URL and complete Authorization header value, and add
the printed bearer-authenticated MCP connection. For Muse, complete the device
pairing first, then configure its MCP connection. See [Hosted agents](agents.md).

## Send a message and check the reply

Send a message from an allowed sender in the bound conversation. The agent should
reply using the incoming request's exact `requestId` so the native conversation,
thread and reply context are retained. Local protocol tests cover these contracts;
they do not establish that an arbitrary live account has the required permissions.

```sh
bin/relanox status --config relanox.json --json
bin/relanox doctor --config relanox.json --management-url http://127.0.0.1:8788
```

Keep `run` active and execute these checks in another terminal. Run `doctor` only
after the first `run` has created the database; a missing database is reported as
an error. If no reply arrives, confirm the sender and conversation IDs, platform
callback registration, and Agent MCP connection in [Operations](operations.md).

Status omits message text unless `--include-content` is supplied. Doctor checks
credentials and an existing database without starting channel connections. See
[Operations](operations.md) and [Deployment](deployment.md) for recovery and backups.
