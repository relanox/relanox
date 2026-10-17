# Relanox

[简体中文](README.zh-CN.md)

[Documentation](https://relanox.github.io/en/quickstart.html)

Relanox connects native messaging channels to existing dot, Grok and Muse agents.
The Go service stores accepted messages, media and outbound work in SQLite or
PostgreSQL using [Ent](https://entgo.io/). It preserves native reply context,
conversation ownership and unknown delivery outcomes across restarts.

Native accounts are composed directly in Go. Tencent speech recognition,
authenticated MCP tools, scoped media, structured
logs, Prometheus metrics and OTLP traces are built into the service. Streaming
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
permission and Agent connection settings before sending a message.

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
go run ./tools/docs
```

The gate checks gofmt, complexity/nesting, vet, golangci-lint and Go tests.
The documentation renderer writes `docs/site`. Read [Architecture](docs/en/architecture.md) and
[Development](docs/en/development.md) before implementation.

Relanox is licensed under the [MIT License](LICENSE). Third-party notices and
distributed dependency licenses are described in [Licenses](licenses/README.md).
