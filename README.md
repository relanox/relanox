# Relanox

[English](README.md) · [简体中文](README.zh-CN.md)

Work with **dot or Grok Bot** from the chat apps you already use.

Run Relanox on your own computer or server, then connect a chat account and an Agent. Send a message in your chat and receive the Agent's reply in the same conversation. You can also share pictures and files, or ask the Agent to send back something it creates.

## Get started

Connect one chat account first. Once you receive your first reply, you can add more conversations.

1. Follow the [quick start](https://relanox.github.io/en/getting-started.html) to install and start Relanox.
2. Choose a [messaging channel](https://relanox.github.io/en/channels/index.html) and prepare its bot account and permissions.
3. [Connect dot or Grok Bot](https://relanox.github.io/en/agents.html), then send your first message.

Channels include Telegram, Discord, Slack, Feishu, WeCom, DingTalk, QQ, Microsoft Teams, WhatsApp Business Cloud, Google Chat, LINE, Matrix, Mattermost, Signal and IRC. Each guide explains account setup, configuration and how to send files.

## Deployment

Use Node.js or deploy with Docker Compose. SQLite is a straightforward starting point; you can also use PostgreSQL. Messages, attachments and delivery progress stay in the database you configure.

- [Change settings and add conversations](https://relanox.github.io/en/configuration.html)
- [Send pictures and files](https://relanox.github.io/en/media.html)
- [Deploy, back up and manage Relanox](https://relanox.github.io/en/operations.html)
- [Check logs and service status](https://relanox.github.io/en/reference/observability.html)

Visit the [documentation](https://relanox.github.io/en/) for the full guide. Report issues on [GitHub](https://github.com/relanox/relanox/issues), or read the [contributing guide](https://relanox.github.io/en/development.html) to help with development.

## License

[MIT](LICENSE).
