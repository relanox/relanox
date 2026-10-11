# Configure conversations and commands

Relanox reads one JSON file. Copy [the SQLite example](https://github.com/relanox/relanox/blob/master/examples/relanox.sqlite.json), then edit it for your accounts and agents. Restart the service after editing to apply the settings.

For a new setup, use the [connection configurator](connect.md): choose channels and Agents on the left and see the configuration update on the right. Expand connection details to enter your hostname, chat IDs and permitted users, then copy or download the JSON. The setup guide follows your selections. Each channel starts with one account and one conversation; add further conversations using bindings below. Credentials stay as environment variable references.

## Choose who can talk to which agent

Three lists describe your connections:

- An **account** (`accounts`) is the bot or service account on a messaging platform, such as a Telegram bot. Its `config` holds platform settings, and `allowedSenders` lists the people permitted to use it.
- An **agent connection** (`endpoints`) is one connected dot or Grok agent. Its `config` holds MCP credentials and the settings for notifying it.
- A **binding** (`bindings`) connects one conversation on an account to one agent. Messages go to that agent, and replies return to that conversation.

For example, this binding sends Telegram chat `123456789` to Grok connection `grok-main`:

```json
{
  "accountId": "telegram-main",
  "chatId": "123456789",
  "endpointId": "grok-main"
}
```

Account and agent names must match entries in their lists. You choose these local names; platform user, chat and thread IDs come from the platform. Write every ID as a string, including numeric IDs. Local names allow letters, digits, underscores and hyphens, begin with a letter or digit, and have a maximum length of 128 characters.

Add a binding for each conversation. Topics or threads need their exact `threadId`:

```json
{
  "accountId": "telegram-main",
  "chatId": "-1001234567890",
  "threadId": "42",
  "endpointId": "grok-main",
  "allowedSenders": ["123456789"]
}
```

Bindings match the exact chat and thread. Omitting `threadId` matches messages with no thread. Configure separate bindings for each topic. Slack uses the root message timestamp as `threadId`, so bind each root thread separately. Account `allowedSenders` is required and contains at least one person. An optional binding `allowedSenders` further restricts the conversation: a sender must appear in both lists. Follow [your channel's guide](channels/index.md) for ID formats.

[The complete example](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) contains fifteen channels and both agents. Copy the entries you need, then replace their IDs, credentials and bindings.

## Store credentials in the environment

Credential fields refer to an environment variable:

```json
{ "env": "TELEGRAM_BOT_TOKEN" }
```

Supply it to the Relanox process. Shell-launched commands read the shell environment; Compose uses its `env_file`. For a source-run process, load values from any `.env` file into the environment first. Google Chat's service-account variable contains the complete service-account JSON.

Use separate MCP tokens for separate agent connections. Keep the Routine's complete Authorization value as supplied, and protect its URL as a secret too. [Connect an agent](agents.md) shows the dot and Grok settings.

To rotate a token, update the service manager's environment and restart. Keep the original bot/account identity while replies remain queued. For a new Grok Routine, use a new variable name and agent connection: pending messages still reference their original settings.

## Choose where messages are stored

SQLite suits a single installation:

```json
{
  "storage": {
    "plugin": "sqlite",
    "config": { "filename": "data/relanox.sqlite" }
  }
}
```

Place this object inside `relay`, and create `data` before starting. Relative paths resolve from the process working directory. An absolute path makes this explicit; Docker uses `/data/relanox.sqlite`.

For PostgreSQL, replace that object:

```json
{
  "storage": {
    "plugin": "postgres",
    "config": {
      "connectionString": { "env": "RELANOX_DATABASE_URL" },
      "schema": "public"
    }
  }
}
```

Supply the connection string in `RELANOX_DATABASE_URL`. Its database user needs permission to create tables and indexes in the configured schema. `run` initializes missing tables and preserves existing messages. Back up before upgrades using [Operations](operations.md).

## Set ports and everyday options

The optional top-level `server` object controls listeners and processing intervals:

| Option              | Default     | When to change it                                                                                    |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `host`              | `127.0.0.1` | Set `0.0.0.0` in a container so its mapped business port is reachable                                |
| `port`              | `8787`      | Change the business port used by your proxy                                                          |
| `managementHost`    | `127.0.0.1` | Use `::1` for IPv6 loopback                                                                          |
| `managementPort`    | `8788`      | Change the local health/metrics port                                                                 |
| `workerIntervalMs`  | `1000`      | Change the delay between processing batches                                                          |
| `workerStaleMs`     | `60000`     | Change how long readiness tolerates a missing successful batch; keep greater than `workerIntervalMs` |
| `startupTimeoutMs`  | `30000`     | Allow more time to initialize platform connections                                                   |
| `shutdownTimeoutMs` | `15000`     | Allow more time for graceful stop, and increase your service manager's stop timeout too              |

Ports accept integers from 0 to 65535; use fixed nonzero ports for deployment. Management uses a literal loopback address. Forward business port 8787 through HTTPS and keep management local. Set agent `mcp.allowedHosts` to the public hostname, including a non-default port. If the MCP client sends Origin, add its exact origin to `mcp.allowedOrigins`; an empty list suits server-to-server clients without this header.

Enable logs and metrics with `relay.observability`:

```json
{
  "observability": {
    "plugin": "standard",
    "config": { "logs": true, "metrics": true, "processMetrics": true }
  }
}
```

Management serves `/health/live`, `/health/ready`, and `/metrics` when enabled. [Observability](reference/observability.md) describes metric names. Configure attachment limits and public download URLs using top-level `media` and `mediaLimits`; see [Media transfer](media.md).

## Use the CLI

Run the built CLI from the repository root. Every command takes `--config <file>` (or `-c`):

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relay.json --limit 100
```

| Command    | Purpose                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `validate` | Check JSON, account settings and bindings before starting                                    |
| `run`      | Initialize storage and keep connections/message processing running                           |
| `doctor`   | Check storage and environment variables; add `--management-url` to check the running service |
| `status`   | Inspect stored incoming messages and replies                                                 |
| `requeue`  | Retry a retained notification or reply after investigating                                   |
| `cleanup`  | Remove eligible old content according to your retention policy                               |

`validate` checks configuration structure. Use `doctor` for missing variables, then send a message to verify the platform connection. A fresh installation needs its first `run` before storage checks become healthy. The management URL for `doctor` is a local HTTP origin such as the example above.

Narrow status queries with:

```sh
node apps/cli/dist/main.js status --config relay.json --endpoint-id grok-main --dispatch-status unknown
node apps/cli/dist/main.js status --config relay.json --delivery-status pending
node apps/cli/dist/main.js status --config relay.json --include-content
```

Dispatch filters are `due`, `accepted`, `rejected`, `unknown`; delivery filters are `pending`, `sent`, `rejected`, `unknown`. Default page size is 100; `--limit` accepts 1–1000. Use `--after-id <id>` to continue after a record. `--include-content` adds message text; protect that output as private conversation data.

[Operations](operations.md#find-and-recover-a-stalled-message) gives recovery and cleanup commands. CLI output is JSON. Exit code 0 means success, 1 means a command failed, and 2 means an unhealthy diagnostic or refused recovery. Use Ctrl+C or the service manager's normal stop command for graceful shutdown.
