# Relanox

[English](README.md) · [简体中文](README.zh-CN.md)

在常用聊天软件里，让 **dot 或 Grok Bot** 帮你做事。

把 Relanox 部署到自己的电脑或服务器，连接聊天账号和 Agent。你在聊天里发消息，Agent 处理后直接回复到原会话。你也可以发送图片和文件，或让 Agent 把生成的内容发回来。

## 开始使用

先连接一个聊天账号，收到第一条回复后，再添加更多会话。

1. 按[快速开始](https://relanox.github.io/zh-CN/getting-started.html)安装并启动 Relanox。
2. 选择[消息渠道](https://relanox.github.io/zh-CN/channels/index.html)，准备机器人账号和权限。
3. [连接 dot 或 Grok Bot](https://relanox.github.io/zh-CN/agents.html)，在聊天里发送第一条消息。

支持 Telegram、Discord、Slack、飞书、企业微信、钉钉、QQ、Microsoft Teams、WhatsApp Business Cloud、Google Chat、LINE、Matrix、Mattermost、Signal 和 IRC。各渠道指南会说明账号准备、配置和文件收发方式。

## 部署

可以使用 Node.js 运行，也可以用 Docker Compose 部署。SQLite 适合直接开始使用；已有 PostgreSQL 的部署也可使用现有数据库。消息、附件和发送进度保存在你配置的数据库中。

- [修改配置与添加会话](https://relanox.github.io/zh-CN/configuration.html)
- [收发图片和文件](https://relanox.github.io/zh-CN/media.html)
- [部署、备份与日常管理](https://relanox.github.io/zh-CN/operations.html)
- [查看日志和运行状态](https://relanox.github.io/zh-CN/reference/observability.html)

完整文档见[文档站](https://relanox.github.io/zh-CN/)。欢迎通过 [GitHub Issues](https://github.com/relanox/relanox/issues)反馈问题，或阅读[贡献指南](https://relanox.github.io/zh-CN/development.html)参与开发。

## 许可证

[MIT](LICENSE)。
