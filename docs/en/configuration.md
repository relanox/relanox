# Configuration

Relanox reads a strict JSON document. Path selection is `--config`/`-c`, then
`RELANOX_CONFIG`, then an existing `relanox.json` in the working directory, then
the user's configuration directory under `relanox/relanox.json`. Relative storage,
credential and Muse directory paths resolve beside the selected JSON file.

## Native account, endpoint and binding

```json
{
  "storage": { "driver": "sqlite", "path": "state/relanox.db" },
  "http": {
    "listen": "127.0.0.1:8787",
    "managementListen": "127.0.0.1:8788",
    "publicUrl": "https://relay.example.com"
  },
  "accounts": [
    {
      "id": "telegram",
      "channel": "telegram",
      "allowedSenders": ["123456789"],
      "config": {
        "botToken": { "env": "TELEGRAM_TOKEN" },
        "webhookSecret": { "file": "secrets/telegram-webhook.secret" }
      }
    }
  ],
  "endpoints": [
    {
      "id": "grok",
      "agent": "grok",
      "config": {
        "mcp": { "auth": "bearer", "token": { "file": "secrets/grok-mcp.secret" } },
        "routineUrl": { "env": "GROK_ROUTINE_URL" },
        "routineAuthorization": { "env": "GROK_ROUTINE_AUTHORIZATION" }
      }
    }
  ],
  "bindings": [
    { "accountId": "telegram", "chatId": "123456789", "endpointId": "grok" }
  ]
}
```

Account and endpoint IDs are local names. Sender, chat and thread IDs preserve
their native platform spelling and remain strings, including large numeric IDs.
Each binding selects one endpoint for an exact account/chat/thread. Its optional
`allowedSenders` further narrows the account list: a sender must appear in both
lists. An empty list is invalid. Omitting it inherits the account list.

## Credentials

A secret reference is `{ "env": "NAME", "file": "relative/path.secret" }`.
Either field may be omitted. A nonempty environment value wins; otherwise Relanox
reads the file at use time, so rotation does not embed old secrets in queued work.
Files contain the actual token, key or JSON credential, rather than a path to a
second secret file. Trailing newlines are removed; empty and oversized files fail.

The CLI creates immutable credential files under `secrets/`, with owner-only Unix
permissions or a Windows DACL limited to the current user and SYSTEM. It never
overwrites old credential files during a refresh. Successful configuration edits
keep the old JSON in a `*.backup-*` file; these files remain private and untracked.

## Scripted setup

```sh
relanox init -c relanox.json --public-url https://relay.example.com
relanox account add -c relanox.json --id telegram --channel telegram \
  --allowed-sender 123456789 --native-config telegram-options.json --json
relanox agent add -c relanox.json --id grok --agent grok \
  --native-config grok-options.json --json
relanox bind -c relanox.json --account telegram --chat 123456789 --endpoint grok --json
relanox validate -c relanox.json --json
```

Native option files contain only the account's or endpoint's `config` object,
including secret references. Interactive commands hide credential input on terminals. `--json` is for scripted
use and requires all non-generated inputs; it never opens a prompt.

## Storage and limits

SQLite uses `storage.driver = "sqlite"` and `storage.path`. PostgreSQL uses
`storage.driver = "postgres"`, a secret reference in `storage.url`, and an optional
schema name in `storage.schema`. Both use the same Ent (`entgo.io/ent`) schema,
generated query builders and transactions. Versioned migrations are shipped with
the source. The Go runtime refuses a legacy TypeScript database or an unsupported
schema format; it does not silently recreate or migrate it.

Defaults are four workers, a 500 ms polling interval, 60-second dispatch leases,
180-second send leases, eight attempts and 30-day retention. Media defaults to
100 MiB per file and total message, with ten attachments. Native limits can be
lower. Configure `queue`, `media` and HTTP timeout fields only when their defaults
do not fit the deployment. Unknown structural fields and invalid bounds fail
offline validation.

## Speech and observability

```json
{
  "speech": {
    "enabled": true,
    "secretId": { "env": "TENCENT_SECRET_ID" },
    "secretKey": { "env": "TENCENT_SECRET_KEY" },
    "region": "ap-guangzhou",
    "engineModelType": "16k_zh"
  },
  "observability": {
    "level": "info",
    "metrics": true,
    "otlpEndpoint": "https://collector.example.com/v1/traces"
  }
}
```

Merge these fields into the main document. Speech prepares incoming audio using
Tencent's hosted ASR service; original content and media remain stored separately.
Operational logs exclude message content and resolved credentials. Metrics are
exposed only on the loopback management listener. OTLP traces are optional.
