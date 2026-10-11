# Configure conversations and commands

Relanox reads one JSON file. Copy [the SQLite example](https://github.com/relanox/relanox/blob/master/examples/relanox.sqlite.json), then edit it for your accounts and agents. Restart the service after editing to apply the settings.

For a new setup, use the [connection configurator](connect.md): choose channels and Agents on the left and see the configuration update on the right. Expand connection details to enter your hostname, chat IDs and permitted users, then copy or download the JSON. The setup guide follows your selections. Each channel starts with one account and one conversation; add further conversations using bindings below. Credentials stay as environment variable references.

The generated file omits default listener settings and monitoring switches. Without a `server` section, the business listener uses `127.0.0.1:8787` and management uses `127.0.0.1:8788`. Omitting `relay.observability` enables standard logs and metrics. Add overrides only when your deployment needs them; containers need `server.host: "0.0.0.0"`.

The configurator requires a public HTTPS address for selected webhook channels and dot OAuth. For Grok, outbound channels such as Discord, WeCom and IRC can leave the service address blank; generated MCP URLs then use `http://127.0.0.1:8787` for local use. Cloud Agents still need a reachable MCP address. An explicit service address is preserved when you switch channels. On narrow screens, settings and preview follow each other in normal page flow.

The configurator generates a 32-byte hexadecimal MCP token in your browser when loaded. You can edit or regenerate it. Copy the exact generated values into your server environment; JSON keeps environment references. Relanox does not automatically load `.env` files. For dot, this value is the OAuth consent password; for Grok, it is the URL token. Manual setup can still use the random-token command in [Quick start](getting-started.md).

## Set your public address once

Set `publicUrl` at the top level, alongside `relay`:

```json
{
  "publicUrl": "https://relay.example.com"
}
```

Relanox uses this address for MCP Host checks, attachment download links and the Google Chat authentication audience. Public media downloads are enabled automatically. The configurator also uses it to show your channel webhook and Agent connection URLs.

Use an HTTPS origin, optionally with a port, without credentials, a path, query or fragment. For local development, literal `http://127.0.0.1:8787` and `http://[::1]:8787` are accepted. The listener address remains controlled by `server`. Keep the public Host header when proxying requests.

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

The optional top-level `server` object controls listeners and startup/shutdown deadlines:

| Option              | Default     | When to change it                                                                       |
| ------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `host`              | `127.0.0.1` | Set `0.0.0.0` in a container so its mapped business port is reachable                   |
| `port`              | `8787`      | Change the business port used by your proxy                                             |
| `managementHost`    | `127.0.0.1` | Use `::1` for IPv6 loopback                                                             |
| `managementPort`    | `8788`      | Change the local health/metrics port                                                    |
| `startupTimeoutMs`  | `30000`     | Allow more time for channel start and CLI administration                                |
| `shutdownTimeoutMs` | `15000`     | Allow more time for graceful stop, and increase your service manager's stop timeout too |

Ports accept integers from 0 to 65535; use fixed nonzero ports for deployment. Management uses a literal loopback address. Forward business port 8787 through HTTPS and keep management local. If the MCP client sends Origin, add its exact origin to `mcp.allowedOrigins`. This identifies the calling client and is separate from your deployment address; the default empty list suits server-to-server clients without this header.

Logs and metrics are enabled by default. Add `relay.observability` only to change their behavior, for example to show warning and error logs:

```json
{
  "observability": {
    "plugin": "standard",
    "config": { "level": "warn" }
  }
}
```

Management serves `/health/live`, `/health/ready`, and `/metrics` when enabled. [Observability](reference/observability.md) describes metric names. Optional `media.urlLifetimeMs` controls download-link lifetime; `mediaLimits` controls attachment sizes. Download URLs use `publicUrl`; see [Media transfer](media.md).

## Update an older configuration

Move your public deployment address into top-level `publicUrl`. Remove `mcp.allowedHosts`, `media.publicBaseUrl`, `media.allowInsecureLocalhost` and Google Chat's `audience`: Relanox derives the host, media origin and Google Chat endpoint URL from the new setting. Remove an empty `media` object unless you want to override link lifetime.

Connection timing and fixed platform identities are now managed internally. If an older file includes any of the fields below, delete them before running `validate`; unknown fields are rejected. dot now accepts only its native OpenAI callback origin. Other fixed timing defaults remain in effect.

| Configuration                                                     | Remove                                              |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| Agent `mcp`                                                       | `maxBodyBytes`, `timeoutMs`                         |
| dot                                                               | `callback`, `subscriptionTtlMs`, `rotationWindowMs` |
| Grok                                                              | `timeoutMs`, `maxBodyBytes`, `routineTransport`     |
| Telegram, Slack, Discord, Feishu, IRC, Matrix, Mattermost, Signal | `timeoutMs`                                         |
| Slack, Discord                                                    | `reconnectDelayMs`                                  |
| IRC, Matrix, Mattermost, Signal                                   | `reconnectMs`                                       |
| Matrix                                                            | `syncTimeoutMs`                                     |
| DingTalk, WeCom, QQ                                               | `maxReconnectAttempts`                              |
| WeCom                                                             | `heartbeatMs`                                       |
| QQ                                                                | `transport`                                         |
| Discord                                                           | `intents`                                           |
| Google Chat                                                       | `callerEmail`, `issuer`                             |
| Microsoft Teams                                                   | `issuer`                                            |

The following deployment internals also use fixed defaults; remove their overrides:

| Configuration           | Remove                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| `server`                | `workerIntervalMs`, `workerStaleMs`                                         |
| SQLite                  | `busyTimeoutMs`                                                             |
| PostgreSQL              | `connectionTimeoutMs`, `idleTimeoutMs`, `statementTimeoutMs`                |
| Standard observability  | `processMetrics`, `logBufferBytes`, `lifecycleTimeoutMs`                    |
| Observability `tracing` | `maxQueueSize`, `maxExportBatchSize`, `scheduledDelayMs`, `exportTimeoutMs` |
| IRC                     | `channels` — channel subscriptions come from this account's bindings        |

Credentials, sender allowlists, trusted origins and deployment addresses remain configurable. The configurator uses native platform addresses automatically; self-hosted services still need their addresses. Advanced server, storage, monitoring and media limits are optional deployment settings.

## Automatically discovered account identities

Relanox queries Slack, Discord, Feishu/Lark, LINE, Matrix and Mattermost with the configured credential at startup to identify the connected account. If discovery fails, startup fails; check the credential and platform connectivity. `validate` stays offline and cannot verify a credential’s account identity.

Remove these fields from existing configurations:

| Channel       | Remove                               | Replacement                                                                                                |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Slack         | `botUserId`, `teamId`, `receiveMode` | Bot token identifies the account; exactly one of `signingSecret` or `appToken` selects HTTP or Socket Mode |
| Discord       | `botUserId`                          | Bot token identifies the account and discovers its Gateway                                                 |
| Feishu / Lark | `botOpenId`                          | App credentials identify the bot; retain `tenantKey`                                                       |
| LINE          | `botUserId`                          | Access token identifies the Official Account                                                               |
| Matrix        | `userId`                             | Access token identifies the account                                                                        |
| Mattermost    | `botUserId`                          | Token identifies the account                                                                               |

Keep the credential attached to the original account while replies remain queued. Application IDs, allowed senders and conversation bindings still describe your intended setup and must be filled in.

### Fixed platform endpoints

Remove these obsolete overrides. Native hosted platforms now use their protocol endpoints automatically:

| Channel                       | Remove                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| Slack, Discord, Feishu / Lark | `apiBaseUrl`, `allowInsecureLoopback`                            |
| Discord                       | `gatewayUrl`                                                     |
| DingTalk                      | `apiBase`, `uploadBase`, `mediaOrigins`, `allowInsecureLoopback` |
| WeCom                         | `wsUrl`, `mediaOrigins`, `allowInsecureLoopback`                 |
| QQ                            | `apiBase`, `mediaOrigins`, `allowInsecureLoopback`               |
| WhatsApp                      | `apiBase`, `apiVersion`, `allowLoopback`                         |
| Google Chat                   | `apiBase`, `tokenUrl`, `jwksUrl`, `allowLoopback`                |
| LINE                          | `apiBase`, `contentApiBase`, `allowLoopback`                     |
| Teams                         | `jwksUrl`, `allowLoopback`                                       |

QQ defaults to production; set `environment` to `"sandbox"` for its sandbox. Relanox manages WhatsApp's Graph API version, currently `v25.0`. Telegram's local Bot API address and the self-hosted Matrix, Mattermost and Signal addresses remain configurable. Teams retains `tokenUrl` for a single-tenant application authority, along with its trusted service, media and upload origins.

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
