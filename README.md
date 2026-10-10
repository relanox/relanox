# Relanox

Bring your hosted AI agents to every channel.

Relanox 是一个开源、自托管的托管 Agent 消息网关，负责渠道接入、授权、会话路由和可靠的异步消息交付。

当前按 [TODO](TODO.md) 实现全部 15 个原生文字渠道，平台完成状态以代码和协议测试为准；本次不做真实账户联调。

- [系统架构与调研](docs/ARCHITECTURE.md)：唯一架构维护文档，包含首版范围、共享核心与四类插件边界、常驻 Node 部署、dot/Grok Bot 接入、原生渠道计划和实现顺序。
- [Grok Bot 官方接入](docs/ARCHITECTURE.md#agent-grok)：Webhook 直接传入消息，自定义 MCP 领取确认与异步回包；区分公开实现证据和待完成的账户验证。
- [可插拔存储](docs/ARCHITECTURE.md#storage)：SQLite/PostgreSQL 事务插件与常驻后台恢复。
- [Discord / Slack / 飞书源码审计](docs/ARCHITECTURE.md#channel-source-audit)：直接实现原生 Channel，参考上游协议处理与边界案例。
- [可观测性](docs/ARCHITECTURE.md#observability)：独立插件提供 JSON 日志、Prometheus 指标和可选 OTLP traces。
- [依赖审计清单](docs/DEPENDENCIES.md)：计划包名、精确候选版本、许可证、用途与审计重点，附 registry 元数据快照。
- [本地参考源码](docs/REFERENCES.md)：`.ref/` 下的上游 clone、固定 commit 和用途；目录已加入 Git 忽略规则。
- [产品需求 PRD v1.0](docs/PRD.md)：当前产品范围与验收要求，与架构和 TODO 同步。

所有渠道采用原生 Channel 插件；dot 等 Hosted Agent 通过独立插件接入。OpenClaw 源码仅作参考，不提供兼容支持。当前没有工程实现、插件补丁或账户联调结果。
