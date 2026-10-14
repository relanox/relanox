# Configuration reference

Manual JSON settings and CLI contracts. For everyday changes, use [Change settings](../configuration.md).

## Manual Telegram and Grok example

After installation, copy the SQLite example if you are not using a downloaded configuration. Keep an existing configurator download instead of overwriting it.

```powershell
Copy-Item examples/relanox.sqlite.json relanox.json
```

On Linux/macOS use `cp examples/relanox.sqlite.json relanox.json`. Replace these values:

| Location                           | Your value                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `relay.accounts[0].allowedSenders` | Your Telegram user ID as a string, for example `["123456789"]`                                |
| `relay.bindings[0].chatId`         | The exact Telegram chat ID as a string                                                        |
| `publicUrl`                        | Your public HTTPS origin, for example `https://relay.example.com`; include a non-default port |
| `relay.storage.config.filename`    | Your database path; the example uses `relanox.sqlite` in the launch directory                 |

The example uses `telegram-main` and `agent-1`. Provide these environment variables before starting:

| Variable                                | Value                                                  |
| --------------------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`                    | BotFather's token                                      |
| `TELEGRAM_WEBHOOK_SECRET`               | Your random Telegram webhook secret                    |
| `RELANOX_AGENT_1_MCP_TOKEN`             | Your separate random MCP token, as a raw token         |
| `RELANOX_AGENT_1_ROUTINE_URL`           | Complete Routine webhook URL                           |
| `RELANOX_AGENT_1_ROUTINE_AUTHORIZATION` | Complete Authorization value supplied for that Routine |

Generate independent secrets for the Telegram webhook and MCP connection:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

See [Quick start](../getting-started.md) to install, supply variables and start the service.

## Generated defaults

The generated file omits default listener settings and monitoring switches. Without a `server` section, the business listener uses `127.0.0.1:8787` and management uses `127.0.0.1:8788`. Omitting `relay.observability` enables standard logs and metrics. Add overrides only when your deployment needs them; containers need `server.host: "0.0.0.0"`.

Both dot and Grok need a publicly reachable HTTPS address for MCP, including with outbound channels. Set `publicUrl` to that address; it is preserved when switching channels.

The configurator generates a 32-byte hexadecimal MCP token in your browser when loaded. You can edit or regenerate it. Copy the exact generated values into your server environment; JSON keeps environment references. Relanox does not automatically load `.env` files. For dot, this value is the OAuth consent password; for Grok, it is the URL token. Manual setup can still use the random-token command in [Quick start](../getting-started.md).

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

For example, this binding sends Telegram chat `123456789` to Grok connection `agent-1`:

```json
{
  "accountId": "telegram-main",
  "chatId": "123456789",
  "endpointId": "agent-1"
}
```

Account and agent names must match entries in their lists. You choose these local names; platform user, chat and thread IDs come from the platform. Write every ID as a string, including numeric IDs. Local names allow letters, digits, underscores and hyphens, begin with a letter or digit, and have a maximum length of 128 characters.

Add a binding for each conversation. Topics or threads need their exact `threadId`:

```json
{
  "accountId": "telegram-main",
  "chatId": "-1001234567890",
  "threadId": "42",
  "endpointId": "agent-1",
  "allowedSenders": ["123456789"]
}
```

Bindings match the exact chat and thread. Omitting `threadId` matches messages with no thread. Configure separate bindings for each topic. For ordinary Slack channel or DM messages, omit `threadId`. For replies inside a Slack thread, use that thread's real root message timestamp as `threadId` and configure an exact binding for it. Account `allowedSenders` is required and contains at least one person. An optional binding `allowedSenders` further restricts the conversation: a sender must appear in both lists. Follow [your channel's guide](../channels/index.md) for ID formats.

[The complete example](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) contains fifteen channels and both agents. Copy the entries you need, then replace their IDs, credentials and bindings.

## Store credentials in the environment

Credential fields refer to an environment variable:

```json
{ "env": "TELEGRAM_BOT_TOKEN" }
```

Supply it to the Relanox process. Shell-launched commands read the shell environment; Compose uses its `env_file`. For a source-run process, load values from any `.env` file into the environment first. Google Chat's service-account variable contains the complete service-account JSON.

Use separate MCP tokens for separate agent connections. Keep the Routine's complete Authorization value as supplied, and protect its URL as a secret too. [Connect an agent](../agents.md) shows the dot and Grok settings.

To rotate a token, update the service manager's environment and restart. Keep the original bot/account identity while replies remain queued. For a new Grok Routine, use a new variable name and agent connection: pending messages still reference their original settings.

## Message middleware

The optional top-level `middleware` array selects registered plugins in execution order. Each entry contains a `plugin` ID and that plugin's `config`. Adding an entry enables it; removing it disables it. Omit the array or use `"middleware": []` to disable all middleware. There is no separate `enabled` flag or fixed entry-count limit. Restart after changing the configuration.

Multiple registered plugins can be combined in the same array; order them as you want messages to be processed. IDs must be unique so saved results remain distinguishable. Unknown IDs are rejected. Only `speech-tencent` is currently bundled; contributors can [register additional implementations](sdk.md#add-message-middleware) without changing the generic validator or loader.

## Optional Tencent speech recognition {#speech-to-text}

To transcribe incoming audio for **dot or Grok**, merge this fragment into your existing `relanox.json`. Keep `relay`, `publicUrl` and the other settings. `middleware` is an optional top-level list, empty by default; the configurator does not generate it:

```json
{
  "middleware": [
    {
      "plugin": "speech-tencent",
      "config": {
        "secretId": { "env": "TENCENT_ASR_SECRET_ID" },
        "secretKey": { "env": "TENCENT_ASR_SECRET_KEY" },
        "engine": "16k_zh"
      }
    }
  ]
}
```

Enable Tencent Cloud ASR and supply its **SecretId and SecretKey**, preferably for a CAM subaccount allowed to call `asr:SentenceRecognition`. Store the actual values in the deployment's private `.env` or service environment, never in JSON or Git:

```dotenv
TENCENT_ASR_SECRET_ID=your-secret-id
TENCENT_ASR_SECRET_KEY=your-secret-key
```

Compose injects these through `env_file`; shell launches must load the environment themselves. Run `relanox validate --config relanox.json`, then `relanox doctor --config relanox.json`, and restart or recreate the service with the updated environment. `validate` checks structure; `doctor` lists missing variable names. Configured but unavailable credentials stop startup with `speech_credentials_missing`. Variables alone do not enable recognition. Remove the `speech-tencent` entry and restart to disable it.

Both credential references are required. `engine` defaults to `16k_zh`; alternatives include `16k_zh-PY` (Mandarin, English and Cantonese), `16k_en` and `16k_yue`. See Tencent's [SentenceRecognition contract](https://cloud.tencent.com/document/api/1093/35646) for available engines and audio requirements.

| Situation                                                         | Forwarded to the agent                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No `speech-tencent` middleware                                    | Original text and audio, unchanged; no ASR request.                                   |
| Successful recognition                                            | Original text followed by a labeled voice transcript, plus every original attachment. |
| Timeout, service error, invalid/empty result or unsupported input | Original text and audio, recognition failures are reported in plugin metadata.        |

The independent `@relanox/speech-tencent` plugin implements the generic message middleware interface for all agents. Core runs an ordered preparation chain; audio selection, recognition, transcript formatting and per-clip fallback belong to the plugin. The CLI bundles it, but only loads the cloud SDK and resolves its credentials when its middleware entry is configured. Core and agent packages do not depend on Tencent. Only `audio` attachments are transcribed; video soundtracks and ordinary files keep their existing behavior. The plugin uses the official [`tencentcloud-sdk-nodejs-asr`](https://github.com/TencentCloud/tencentcloud-sdk-nodejs) SDK for signing, HTTPS requests and API error handling. Audio is sent in the request body; no public audio URL, local inference, transcoding or long-audio splitting is used. Formats: WAV, PCM, Ogg Opus, Speex, SILK, MP3, M4A, AAC and AMR. Ogg Vorbis and WebM fall back. QQ SILK is detected even if labeled AMR. PCM must already meet the chosen engine's requirements.

The service accepts audio up to 60 seconds. Relanox conservatively limits **Base64 data to 3,000,000 bytes** (2,250,000 raw bytes). Known durations over 60 seconds are skipped; otherwise Tencent validates the actual audio. HTTP calls have an eight-second deadline, and the entire middleware chain has a ten-second deadline. Multiple clips have independent outcomes in attachment order. These limits are separate from ordinary media limits.

Original messages and bytes are committed before ingress is acknowledged. The worker transcribes afterward; unfinished preparation is hidden from agent message reads and cannot receive correlated replies. Results are stored separately from the immutable snapshot in SQLite or PostgreSQL. Notifications and `relanox_read_messages` expose identical prepared content, including `extensions["speech-tencent"].transcriptions` entries with `mediaId`, `status` and either `text` or `errorCode`. Message retention clears transcript text too. No database schema change is required.

Each selected audio attachment gets at most one recognition attempt. Stored results are reused on notification retries, explicit redispatch and restart. Waiting jobs resume after restart. If processing was interrupted before the chain results were saved and its lease expired, Relanox records a middleware `interrupted` failure and forwards the original audio instead of repeating a potentially charged call. Removing configuration or switching providers makes still-waiting jobs fall back with `disabled`; completed results remain usable. Resending as a new platform message starts a new attempt.

Recognition may incur charges; check Tencent's current [billing documentation](https://cloud.tencent.com/document/product/1093/35686). Recognition failures appear in `transcription.failed` logs; missing, interrupted, invalid or timed-out middleware steps appear in `middleware.failed` logs. Such step failures have no speech metadata and keep the preceding content. Middleware metrics are `relanox_middleware_total` and `relanox_preparation_duration_seconds`; speech metrics are `relanox_transcription_total` and `relanox_transcription_duration_seconds`. Logs omit audio, transcript text and credentials. Raw forwarding alone does not guarantee that the agent can understand audio. Local tests verify protocol and fallback behavior, not live-account recognition quality.

Upgrading from the previous speech configuration: replace the top-level `speechToText` object with the array above and use plugin ID `speech-tencent`. The old configuration is rejected rather than silently disabling recognition. Stop old workers and back up the database before upgrading. Startup converts the previous speech records in bounded transactions, preserving original content, saved transcripts and pending leases without making cloud calls. Table schemas are unchanged; do not run old and new workers together or downgrade the converted database. Agent consumers should read the new namespaced `extensions` field.

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

Supply the connection string in `RELANOX_DATABASE_URL`. Its database user needs permission to create tables and indexes in the configured schema. `run` initializes missing tables and preserves existing messages. Back up before upgrades using [Operations](../operations.md).

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

Management serves `/health/live`, `/health/ready`, and `/metrics` when enabled. [Observability](observability.md) describes metric names. Optional `media.urlLifetimeMs` controls download-link lifetime; `mediaLimits` controls attachment sizes. Download URLs use `publicUrl`; see [Media transfer](../media.md).

## Automatically discovered account identities

Relanox queries Slack, Discord, Feishu/Lark, LINE, Matrix and Mattermost with the configured credential at startup to identify the connected account. If discovery fails, startup fails; check the credential and platform connectivity. `validate` stays offline and cannot verify a credential’s account identity.

Keep the credential attached to the original account while replies remain queued. Application IDs, allowed senders and conversation bindings still describe your intended setup and must be filled in.

### Fixed platform endpoints

Native hosted platforms use their protocol endpoints automatically.

QQ defaults to production; set `environment` to `"sandbox"` for its sandbox. Relanox manages WhatsApp's Graph API version, currently `v25.0`. Telegram's local Bot API address and the self-hosted Matrix, Mattermost and Signal addresses remain configurable. Teams retains `tokenUrl` for a single-tenant application authority, along with its trusted service, media and upload origins.

## Install and load native plugins

Channels, agents, storage, observability and message middleware are independent packages. Official names follow `@relanox/channel-<channel>`, `@relanox/agent-<agent>`, `@relanox/storage-<storage>` and `@relanox/observability-standard`; Tencent speech middleware uses `@relanox/speech-tencent`. Account and endpoint selectors keep their native IDs, such as `telegram`, `grok`, `sqlite` and `standard`. Configured message middleware uses the same installation directory and override rules; the optional top-level `middleware` array controls which middleware runs and in what order.

Use the explicit installer when you need a separately installed package. This npm example works only after the exact version exists on your configured npm registry; it does not establish that version 0.1.0 has been published:

```sh
node apps/cli/dist/main.js plugins install @relanox/channel-telegram@0.1.0 --config relanox.json
```

Registry packages require an exact version; tags and version ranges are rejected. You can also install a locally packed archive:

```sh
node apps/cli/dist/main.js plugins install ./artifacts/relanox-channel-telegram-0.1.0.tgz --config relanox.json
```

The installer reads only the top-level `plugins` settings, so it can run before the relay, bindings or credentials are complete. A JSON file containing `{}` uses the default installation directory. Installation uses npm with lifecycle scripts disabled, checks the package manifest and compiled entrypoint, and records its native kind and ID. It does not start the plugin.

The default directory is `.relanox/plugins` beside the configuration file. To choose another directory or override an installed plugin with a local package, add this top-level object:

```json
{
  "plugins": {
    "directory": "./data/plugins",
    "load": {
      "paths": ["./local/channel-telegram"]
    }
  }
}
```

`plugins.directory`, `plugins.load.paths` and relative installer archive paths resolve beside the configuration file, independently of the launch directory. Each override path points to a package directory containing its `package.json` and compiled entrypoint, not to a TypeScript file.

For each required native kind and ID, loading uses this order:

1. An explicit package in `plugins.load.paths`.
2. The installation directory's `node_modules`, using the package name recorded in `relanox-plugins.json`, or the official name when no mapping exists.
3. CLI module resolution for that same package name, including workspace development dependencies or plugins assembled into a distribution.

A registry mapping chooses the package name for the installation-directory and CLI lookup; the official name is used when no mapping exists. Two override packages declaring the same kind and ID fail with `plugin_duplicate_override`. An invalid override fails validation or startup instead of falling back to an installed copy.

`validate` loads the required plugin modules and checks their contracts and configuration asynchronously, without opening platform or storage connections. Importing executes package code; use trusted packages. Validation and normal startup do not install packages or contact an npm registry. Plugin changes require a rebuild when developing locally, then a service restart; there is no hot reload.

Preserve the installation directory's `package.json`, npm lockfile, `relanox-plugins.json`, installed packages and any local archives when backing up or moving the installation. The registry maps native kind/ID pairs to installed npm package names.

See [Adding an integration](sdk.md) for the package manifest and factory contract, and [Operations](../operations.md) for selecting plugins in a container.

## Use the CLI

Run the built CLI from the repository root. Every command takes `--config <file>` (or `-c`):

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relanox.json --limit 100
```

| Command    | Purpose                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `validate` | Check JSON, account settings and bindings before starting                                    |
| `run`      | Initialize storage and keep connections/message processing running                           |
| `doctor`   | Check storage and environment variables; add `--management-url` to check the running service |
| `status`   | Inspect stored incoming messages and replies                                                 |
| `requeue`  | Retry a retained notification or reply after investigating                                   |
| `cleanup`  | Remove eligible old content according to your retention policy                               |

`plugins install <spec>` installs an exact npm package version or a local `.tgz` using only the configuration's plugin settings. See [Install and load native plugins](#install-and-load-native-plugins).

`validate` checks configuration structure and required plugin contracts without opening connections. Use `doctor` for missing variables, then send a message to verify the platform connection. A fresh installation needs its first `run` before storage checks become healthy. The management URL for `doctor` is a local HTTP origin such as the example above.

Narrow status queries with:

```sh
node apps/cli/dist/main.js status --config relanox.json --endpoint-id agent-1 --dispatch-status unknown
node apps/cli/dist/main.js status --config relanox.json --delivery-status pending
node apps/cli/dist/main.js status --config relanox.json --include-content
```

Dispatch filters are `due`, `accepted`, `rejected`, `unknown`; delivery filters are `pending`, `sent`, `rejected`, `unknown`. Default page size is 100; `--limit` accepts 1–1000. Use `--after-id <id>` to continue after a record. `--include-content` adds message text; protect that output as private conversation data.

[Operations](../operations.md#find-and-recover-a-stalled-message) gives recovery and cleanup commands. CLI output is JSON. Exit code 0 means success, 1 means a command failed, and 2 means an unhealthy diagnostic or refused recovery. Use Ctrl+C or the service manager's normal stop command for graceful shutdown.
