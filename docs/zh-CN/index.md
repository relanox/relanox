---
layout: home
title: 文档
hero:
  name: Relanox
  text: 在消息渠道中使用已有的 Agent。
  tagline: 面向 dot 和 Grok Bot 的自托管消息网关。接收文字和媒体、持久保存交接状态，再将回复发回原会话。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh-CN/getting-started
    - theme: alt
      text: 配置消息渠道
      link: /zh-CN/configuration
features:
  - title: 15 个原生渠道
    details: 通过平台消息协议连接 Telegram、Discord、Slack、飞书、企业微信、钉钉、QQ 等渠道。
  - title: 持久交接
    details: 使用 SQLite 或 PostgreSQL 保存入站消息、通知状态和发送进度，重启后继续处理。
  - title: 自行部署
    details: 运行 Node 服务或 Docker 容器，通过环境变量管理凭据，并使用日志、指标和 trace 监控服务。
---

## 从一条完整的消息路径开始

配置渠道账号、Agent endpoint 和两者之间的绑定。Relanox 负责消息传输，由你的托管 Agent 完成任务。

- [安装并启动服务](getting-started.md)
- [连接 dot 或 Grok Bot](agents.md)
- [收发媒体](media.md)
- [部署、备份与恢复发送](operations.md)

## 接入渠道

Relanox 按各渠道原生能力处理文字和媒体。选择渠道后，按对应文档配置账号、权限和消息绑定。
