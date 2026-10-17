# Relanox

Relanox connects native messaging channels to existing dot, Grok and Muse agents.
This checkout is undergoing a complete Go rewrite. The earlier TypeScript source,
tests, configuration and documentation are preserved under
[`ref/typescript`](ref/typescript/README.md) for reference.

The Go foundation currently defines typed channel, agent, storage, media and queue
contracts, configuration loading and bounded HTTP transport. An interface is not a
working integration. The executable and native implementations are being rebuilt;
the archived TypeScript instructions do not describe the Go runtime.

The intended scope includes Telegram, Discord, Slack, Feishu, WeCom, WeChat,
DingTalk, QQ, Microsoft Teams, WhatsApp, Matrix, Google Chat, LINE, Mattermost,
Signal and IRC, with native text/media capabilities, SQLite/PostgreSQL, Tencent
speech, MCP, reliable delivery and observability. Components are composed directly
in Go; there is no plugin system. Streaming replies and local inference are outside
the scope.

Development requires Go 1.26. Run:

```sh
git config core.hooksPath .githooks
go run ./tools/check
```

Read the [architecture](docs/en/architecture.md) and
[development guide](docs/en/development.md) before changing the runtime.
Relanox is licensed under the [MIT License](LICENSE). Historical third-party
notices are retained with the archived implementation.
