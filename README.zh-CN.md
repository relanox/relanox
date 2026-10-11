# Relanox

[English](README.md) · [简体中文](README.zh-CN.md)

在消息渠道中使用已有的托管 AI Agent。

Relanox 是面向 **dot 和 Grok Bot** 的自托管消息网关。它接收文字和媒体、持久保存交接状态，再将异步结果发回原会话；本身不运行模型。

支持 Telegram、Discord、Slack、飞书、企业微信、钉钉、QQ、Microsoft Teams、WhatsApp Business Cloud、Google Chat、LINE、Matrix、Mattermost、Signal 和 IRC。真实平台账号兼容性仍为实验性，各渠道的权限要求与限制在文档中单独说明。

## 开始使用

使用 Node.js 26 和 pnpm 12.11.2，或通过 Docker Compose 部署。默认存储为 SQLite，也支持 PostgreSQL。

- [安装与快速开始](https://relanox.github.io/zh-CN/getting-started.html)
- [配置与命令](https://relanox.github.io/zh-CN/configuration.html)
- [媒体传输与平台限制](https://relanox.github.io/zh-CN/media.html)
- [部署、备份与恢复](https://relanox.github.io/zh-CN/operations.html)
- [开发维护](https://relanox.github.io/zh-CN/development.html)

[文档站](https://relanox.github.io/)提供英文和简体中文，源码位于 [docs](docs/zh-CN/index.md)。

## 许可证

采用 [MIT](LICENSE) 许可证。
