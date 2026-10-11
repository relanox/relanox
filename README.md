# Relanox

Bring your hosted AI agents to every channel.

Relanox 是一个开源、自托管的消息网关。它把渠道文字交给你已有的 dot 或 Grok Bot，持久保存交接状态，再把异步结果发回原会话；本身不运行模型。

提供 15 个原生文字通道：Telegram、Discord、Slack、飞书、企业微信、钉钉、QQ、Microsoft Teams、WhatsApp Business Cloud、Matrix、Google Chat、LINE、Mattermost、Signal 和 IRC。各通道的具体接收方式、权限、线程和发送限制见[通道文档](docs/CLI.md)。所有通道均通过文档协议和本地服务测试，**真实账户支持仍为实验性，本次未做账户联调**。

## 开始使用

需要 Node.js 26 和 pnpm 12.11.2。仓库提供常驻 CLI 和 Docker/Compose 部署。

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js validate --config ./relanox.json
node apps/cli/dist/main.js run --config ./relanox.json
```

按 [CLI 与配置示例](docs/CLI.md)创建配置，并通过环境变量提供凭据。迁移是显式命令，启动不会自动迁移。默认使用 SQLite，也可选择 PostgreSQL；每个实例只使用一个权威数据库。

容器安装、HTTPS 代理、备份、升级和未知发送恢复见[运维指南](docs/OPERATIONS.md)。管理健康检查与指标只监听回环地址，和公开的渠道/Agent HTTP 接口分开。

## 交付语义

- 接收时校验平台身份、发送者 allowlist 和固定绑定；成功持久化后确认接收。
- 接纳时冻结 Agent endpoint 和回复目标，后续修改绑定不会把旧结果发给另一个会话。
- 每个 endpoint 同时只有一个活跃请求。Agent 用处理令牌完成任务；重启不会自动重跑已领取的远端任务。
- 结果与出站记录在同一事务保存。已发送分片保留回执，剩余分片可从数据库恢复。
- 明确的临时失败可重试；平台发送结果未知时保留状态，要求显式恢复，不能保证外部副作用恰好一次。

JSON 日志、Prometheus 指标和可选 OTLP tracing 由独立观测插件提供。媒体、卡片、流式回复、管理面板、多租户和 Serverless 不在当前范围。Matrix 目前只支持非加密文字；Signal 需要单独部署的非官方 signal-cli 服务。

## 开发与文档

[开发指南](docs/DEVELOPMENT.md)说明构建、测试和插件边界。Oxfmt 与启用类型检查的 Oxlint 在 pre-commit 和 CI 执行；测试使用 Vitest、真实 SQLite/PostgreSQL 和本地 HTTP/socket 协议服务。

- [产品需求](docs/PRD.md)、[架构](docs/ARCHITECTURE.md)和[实现清单](TODO.md)
- [SDK 持久语义](docs/SDK.md)、[Core 装配 API](docs/CORE.md)、[dot/Grok 协议](docs/AGENTS_PROTOCOL.md)
- [依赖审计](docs/DEPENDENCIES.md)、[第三方许可](docs/LICENSES.md)、[协议来源](docs/PROTOCOLS.md)

OpenClaw 等项目仅作为协议行为参考，不是运行时依赖，也不提供插件或配置兼容。Relanox 以 [MIT](LICENSE) 许可证发布。
