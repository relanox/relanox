# Relanox

[English](README.md) · [简体中文](README.zh-CN.md)

Bring your hosted AI agents to your messaging channels.

Relanox is a self-hosted message gateway for **dot and Grok Bot**. It receives text and media, persists the handoff and returns asynchronous results to the original conversation. It does not run models.

Supports Telegram, Discord, Slack, Feishu, WeCom, DingTalk, QQ, Microsoft Teams, WhatsApp Business Cloud, Google Chat, LINE, Matrix, Mattermost, Signal and IRC. Platform account compatibility remains experimental; channel permissions and limitations are documented individually.

## Get started

Use Node.js 26 and pnpm 12.11.2, or deploy with Docker Compose. SQLite is the default storage; PostgreSQL is also supported.

- [Installation and quick start](https://relanox.github.io/en/getting-started.html)
- [Configuration and commands](https://relanox.github.io/en/configuration.html)
- [Media transfer and platform limits](https://relanox.github.io/en/media.html)
- [Deployment, backups and recovery](https://relanox.github.io/en/operations.html)
- [Development](https://relanox.github.io/en/development.html)

The [documentation site](https://relanox.github.io/) is available in English and Simplified Chinese. Its source is in [docs](docs/en/index.md).

## License

[MIT](LICENSE). Third-party license texts are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
