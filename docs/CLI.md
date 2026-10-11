# Resident CLI

Build with `pnpm install --frozen-lockfile` and `pnpm build`, then use Node 26:

```sh
node apps/cli/dist/main.js validate --config examples/relanox.sqlite.json
node apps/cli/dist/main.js doctor --config examples/relanox.sqlite.json
node apps/cli/dist/main.js run --config examples/relanox.sqlite.json
```

The executable also installs as `relanox` through the package bin. The configuration is a strict JSON object with `relay` (the [SDK/core configuration](CORE.md)) and optional `server`. Config and SecretRefs are static for the process lifetime. Credentials resolve from environment references at use; values are never printed by validate, doctor, status defaults, or command errors. Example identities, bindings and hosts must be replaced with the actual configured identities. Validation does not contact a platform or prove account permissions.

SQLite filenames resolve against the process working directory, not the config file directory. Create any parent directory before run. PostgreSQL replaces `relay.storage` with `{ "plugin": "postgres", "config": { "connectionString": { "env": "RELANOX_DATABASE_URL" }, "schema": "public" } }`; the environment variable holds the actual DSN. Run automatically creates missing tables and indexes without clearing existing records. Run refuses unavailable storage. Doctor/status only inspect storage and never initialize its schema or start channel connections.

| Server option                       | Default              | Purpose                                                              |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `host` / `port`                     | `127.0.0.1` / `8787` | Native plugin business HTTP listener                                 |
| `managementHost` / `managementPort` | `127.0.0.1` / `8788` | Management listener; host must be literal `127.0.0.1` or `::1`       |
| `workerIntervalMs`                  | `1000`               | Delay between completed durable batches; batches never overlap       |
| `workerStaleMs`                     | `60000`              | Maximum age of a successful batch; must exceed interval              |
| `startupTimeoutMs`                  | `30000`              | Bound native connection initialization                               |
| `shutdownTimeoutMs`                 | `15000`              | One total shutdown budget across draining, storage and observability |

Use `host: "0.0.0.0"` in a container and terminate HTTPS at a trusted reverse proxy. Only business HTTP paths need forwarding. Agent host/origin allowlists must describe the external URL. Management serves GET `/health/live`, `/health/ready`, and `/metrics` when enabled. It exposes no administrative records or recovery endpoint. Business HTTP does not serve management health/metrics. Readiness checks storage/version, accepting state, worker failure and batch freshness. Connection health is exported through `relanox_connection_status` metrics and structured connection diagnostics; live account validation is excluded.

Run owns native connections and one durable worker. Connected channels can persist inbound messages while other native connections are still initializing. After connection initialization, the worker processes its first durable batch in the background; readiness stays HTTP 503 until that batch succeeds. Persisted backlog processing is not part of `startupTimeoutMs`. SIGINT/SIGTERM stop acceptance, abort connections, close listeners and wait for in-flight work within the total shutdown budget. Cleanup still attempts storage and observability if another cleanup fails. Timeout reports a redacted command failure; it does not promise remote cancellation or that an uncertain external effect was undone. Persisted leases and unknown-state recovery remain authoritative after restart. Partial startup failures release acquired resources.

```sh
node apps/cli/dist/main.js status --config relay.json --limit 100
node apps/cli/dist/main.js status --config relay.json --endpoint-id grok-main --request-status claimed
node apps/cli/dist/main.js status --config relay.json --include-content
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js requeue --config relay.json --kind request --id REQUEST_ID --expected-version 4
node apps/cli/dist/main.js requeue --config relay.json --kind delivery --id DELIVERY_ID --expected-version 7 --acknowledge-unknown
node apps/cli/dist/main.js cleanup --config relay.json --before 1790000000000 --limit 100
```

Status reads persisted stats and independent request/delivery pages. `--after-id` is an exclusive ID cursor, `--delivery-status` filters deliveries, and `--endpoint-id` scopes both. Default projections omit message text, endpoint configuration, processing tokens, targets and receipts. Explicit `--include-content` adds message/result text only. This output is local administrative data and should be handled accordingly. Doctor reports missing environment variable names, storage health, and optionally running readiness from an explicitly supplied loopback HTTP origin. It refuses redirects and remote management origins.

Requeue requires the current record version shown by status and returns `updated`, `not_found`, `conflict`, or `unauthorized`. An unknown attempt requires `--acknowledge-unknown`; this acknowledges possible duplicate external effects. It revokes only local persisted claims/leases, preserves sent delivery chunks, and cannot cancel an already running remote agent. Cleanup redacts eligible terminal text while preserving deduplication and all unfinished/undelivered work. Exit codes are 0 for success/help, 1 for a redacted command failure, and 2 for an unhealthy doctor or rejected recovery. JSON command errors intentionally omit arbitrary provider/driver exception messages.

The CLI statically includes all 15 native channel factories and dot/Grok. The [full configuration example](../examples/relanox.all-channels.json) contains every account plus both agent endpoints; the [minimal SQLite example](../examples/relanox.sqlite.json) uses Telegram/Grok. Run `node apps/cli/dist/main.js validate --config examples/relanox.all-channels.json` to check every configured schema without resolving credentials, opening storage, or starting connections. Select the accounts and bindings needed for your deployment, then replace example identities, environment references, hosts, room/conversation IDs and exact thread bindings. The full example enables no remote insecure transports and does not register platform webhooks or create accounts.

| Native channel  | Required account configuration                                                                                    | Protocol and binding guide                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Telegram        | `botToken`, `webhookSecret`                                                                                       | [Bot API webhook, chat/topic/reply](channels/telegram.md)                       |
| Discord         | `botToken`, `botUserId`                                                                                           | [Gateway, Message Content intent, channel/thread](channels/discord.md)          |
| Slack           | `receiveMode`, `botToken`, `botUserId`, `teamId`, `appId`; `signingSecret` for HTTP or `appToken` for Socket Mode | [Events or Socket Mode, channel/thread](channels/slack.md)                      |
| Feishu / Lark   | `appId`, `appSecret`, `verificationToken`, `encryptKey`, `tenantKey`, `botOpenId`                                 | [Signed/encrypted HTTP subscription, tenant/thread](channels/feishu.md)         |
| WeCom           | `botId`, `secret`                                                                                                 | [Intelligent robot WebSocket, DM/group](channels/wecom.md)                      |
| DingTalk        | `clientId`, `clientSecret`, `robotCode`                                                                           | [Application robot Stream, independent OpenAPI send](channels/dingtalk.md)      |
| QQ              | `appId`, `clientSecret`, `transport: "websocket"`                                                                 | [Official C2C/group protocol, sequence/window](channels/qq.md)                  |
| Microsoft Teams | `appId`, `botId`, `tenantId`, `appSecret`, `trustedServiceOrigins`                                                | [Authenticated activity, proactive conversation reference](channels/msteams.md) |
| WhatsApp        | `phoneNumberId`, `businessAccountId`, `apiVersion`, `appSecret`, `verifyToken`, `accessToken`                     | [Business Cloud API, customer-service window](channels/whatsapp.md)             |
| Matrix          | `homeserver`, `userId`, `accessToken`                                                                             | [Sync, rooms/threads, encrypted input unsupported](channels/matrix.md)          |
| Google Chat     | `audience`, `serviceAccount`                                                                                      | [HTTP app OIDC, app-authenticated spaces/threads](channels/googlechat.md)       |
| LINE            | `botUserId`, `channelSecret`, `accessToken`                                                                       | [Signed webhook, independent user/group/room push](channels/line.md)            |
| Mattermost      | `serverUrl`, `botUserId`, `token`                                                                                 | [Authenticated WebSocket, REST channel/thread posts](channels/mattermost.md)    |
| Signal          | `serviceUrl`, `account`; recommended `selfUuid` and proxy `authorization`                                         | [Unofficial signal-cli SSE/JSON-RPC prerequisites](channels/signal.md)          |
| IRC             | `server`, `nick`; select joined `channels` and network credentials                                                | [TLS registration, SASL, account-tag identities](channels/irc.md)               |

Credential fields use environment SecretRefs (`{"env":"VARIABLE_NAME"}`); Google Chat's service-account JSON is the referenced environment value. Channel guides distinguish IDs from credentials and list optional transport settings, account permissions and limitations. dot/Grok configuration and authenticated MCP routes are in the [agent protocol guide](AGENTS_PROTOCOL.md). Real-account compatibility remains experimental.
