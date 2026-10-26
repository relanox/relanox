# Relanox

[简体中文](README.zh-CN.md)

[Documentation](https://relanox.github.io/en/quickstart.html)

Relanox connects native messaging channels to existing dot, Grok and Muse agents.
The Go service stores incoming messages, media and queued outgoing messages in SQLite or
PostgreSQL. After a restart, messages retain their conversation, assigned agent,
native reply context and delivery status, including sends whose outcome is unknown.

The service includes Tencent speech recognition, authenticated MCP tools,
media access controls, structured logs, Prometheus metrics and OTLP traces. Streaming
replies, local inference and Serverless execution are outside the supported scope.

## Start from source

Use Go 1.27.2:

```sh
go build -trimpath -o bin/relanox ./cmd/relanox
bin/relanox init --config relanox.json --public-url https://relay.example.com
bin/relanox setup --config relanox.json
bin/relanox validate --config relanox.json
bin/relanox run --config relanox.json
```

On Windows, build `bin/relanox.exe`. The wizard writes private credential files,
creates configuration backups and prints the native callback and MCP URLs.
WeChat pairing saves the confirmed bot and user automatically. Muse uses an
existing paired device directory. Finish the external application's callback,
permission and agent connection settings before sending a message.

Read [Quickstart](docs/en/quickstart.md), [Configuration](docs/en/configuration.md),
[Native channels](docs/en/channels.md), [Agents](docs/en/agents.md),
[Operations](docs/en/operations.md) and [Deployment](docs/en/deployment.md).
Local protocol/integration tests do not establish live-account compatibility.
For prebuilt binaries and container usage, see [Deployment](docs/en/deployment.md).

## Development

Install the golangci-lint version in `.golangci-lint-version` into `bin/` or onto
`PATH` as described in the [development guide](docs/en/development.md).

```sh
git config core.hooksPath .githooks
go run ./tools/check
pnpm install --frozen-lockfile
pnpm docs:build
```

The gate checks gofmt, complexity/nesting, vet, golangci-lint and Go tests.
The VitePress documentation build uses Node.js 24.14.1 and writes `docs/.vitepress/dist`.
Read [Architecture](docs/en/architecture.md) and
[Development](docs/en/development.md) before implementation.

Relanox is licensed under the [MIT License](LICENSE).
