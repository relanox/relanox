# 依赖与审计清单

核对日期：2026-10-11。直接依赖固定精确版本，解析结果以根 pnpm-lock.yaml 为准。下表记录实际选型与审计重点；registry 元数据和 tarball integrity 见 [JSON 快照](DEPENDENCIES.snapshot.json)，完整已安装生产依赖的许可证清单见 [LICENSES](LICENSES.md)。元数据快照不替代 lockfile；本地和 CI 检查证据见 TODO。

运行环境采用 Node.js 26.11.1 Current、ESM + TypeScript 和 pnpm workspace；Docker 固定 Node 26.11.1 的镜像摘要。Node 状态依据[官方发布表](https://nodejs.org/en/about/previous-releases)。引入时固定精确版本和 lockfile，Node 类型包同步使用最新 26.x。全部直接依赖与 pnpm 已核对 npm 的 latest 稳定标签，排除预发布版；精确版本固定，避免构建时浮动。

## 1. 运行时直接依赖

以下 17 个包覆盖全部 v0.1 插件组合。CLI 同时装配两种存储插件，运行时按配置只打开一种。插件依赖归各自包，sdk 保持纯契约，core 不 import 数据库驱动或观测库。所有 npm 链接指向具体固定版本。

| 包 / 固定版本                                                                                                                      | 许可证声明 | 引入位置与用途                                                          | 审计重点                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [hono 4.13.13](https://www.npmjs.com/package/hono/v/4.13.13)                                                                       | MIT        | core：HTTP 路由与 Web Request/Response handler                          | 限制请求体、路由鉴权和代理信任；不引入额外 Web 框架                                                     |
| [@hono/node-server 2.1.4](https://www.npmjs.com/package/@hono/node-server/v/2.1.4)                                                 | MIT        | CLI：Node listener 适配                                                 | 与 Hono 组合及 HTTP 超时/关闭行为需验证；[官方 Node 接入](https://hono.dev/docs/getting-started/nodejs) |
| [zod 4.6.5](https://www.npmjs.com/package/zod/v/4.6.5)                                                                             | MIT        | core/各插件：外部配置、事件与工具参数校验                               | MCP v2 也依赖 Zod 4；SDK 接口不强制暴露 Zod 类型；仅直接使用的包声明依赖                                |
| [better-sqlite3 13.0.3](https://www.npmjs.com/package/better-sqlite3/v/13.0.3)                                                     | MIT        | storage-sqlite：事务、预编译语句、WAL                                   | 原生二进制/构建链与目标平台分发；同步查询会阻塞事件循环，控制事务时长并测量                             |
| [pg 8.23.1](https://www.npmjs.com/package/pg/v/8.23.1)                                                                             | MIT        | storage-postgres：连接池与显式 SQL 事务                                 | 使用普通 JS 驱动，不选 pg-native；TLS、池上限、事务连接释放                                             |
| [@modelcontextprotocol/server 2.3.1](https://www.npmjs.com/package/@modelcontextprotocol/server/v/2.3.1)                           | Apache-2.0 | agent-dot/agent-grok：MCP 服务端及 HTTP handler                         | v2 与旧统一 SDK 名称/许可不同；dot Events、Grok 协商和 session 行为要真实验证                           |
| [standardwebhooks 1.1.1](https://www.npmjs.com/package/standardwebhooks/v/1.1.1)                                                   | MIT        | agent-dot：事件通知签名                                                 | key 编码、原始字节、时间戳和稳定事件 ID；不自行重写密码学协议                                           |
| [ws 8.22.0](https://www.npmjs.com/package/ws/v/8.22.0)                                                                             | MIT        | 原生长连接渠道：WebSocket 连接与协议帧                                  | 强类型帧校验、心跳、认证、重连；不带入完整平台 runtime                                                  |
| [jose 6.2.12](https://www.npmjs.com/package/jose/v/6.2.12)                                                                         | MIT        | Teams/Google Chat 等 JWT/JWKS 验证、服务凭据签名                        | 固定 issuer/audience/JWKS 信任边界；不接受消息指定认证目标                                              |
| [commander 15.0.0](https://www.npmjs.com/package/commander/v/15.0.0)                                                               | MIT        | CLI：启动、校验、查看状态等命令                                         | 不增加交互式向导框架；Node 要求 >=22.12，Node 26 满足                                                   |
| [pino 10.4.0](https://www.npmjs.com/package/pino/v/10.4.0)                                                                         | MIT        | observability-standard：结构化 JSON 日志                                | 脱敏、错误序列化、stdout 背压；不默认记录请求/响应或安装 transport 集合                                 |
| [@prometheus-io/client 0.16.1](https://www.npmjs.com/package/@prometheus-io/client/v/0.16.1)                                       | Apache-2.0 | observability-standard：Prometheus Registry、计数/直方图/状态及进程指标 | 标签基数、有界桶、独立 Registry，禁用重复全局注册；[上游文档](https://github.com/prometheus/client_js)  |
| [@opentelemetry/api 1.9.1](https://www.npmjs.com/package/@opentelemetry/api/v/1.9.1)                                               | Apache-2.0 | observability-standard：trace/context API                               | 保持单个兼容 API 实例；SDK 的 peer 范围需匹配                                                           |
| [@opentelemetry/sdk-trace-node 2.12.0](https://www.npmjs.com/package/@opentelemetry/sdk-trace-node/v/2.12.0)                       | Apache-2.0 | observability-standard：Node tracer provider 和异步上下文               | provider 生命周期、并发上下文隔离；不加载全量自动插桩                                                   |
| [@opentelemetry/sdk-trace-base 2.12.0](https://www.npmjs.com/package/@opentelemetry/sdk-trace-base/v/2.12.0)                       | Apache-2.0 | observability-standard：批处理 span processor、采样配置                 | 有界队列、导出超时；与 trace-node 属同一发行系列；显式导入则显式声明依赖                                |
| [@opentelemetry/resources 2.12.0](https://www.npmjs.com/package/@opentelemetry/resources/v/2.12.0)                                 | Apache-2.0 | observability-standard：service.name/version 等资源属性                 | 只配置必要属性，不扫描云环境或注入敏感主机信息                                                          |
| [@opentelemetry/exporter-trace-otlp-http 0.223.0](https://www.npmjs.com/package/@opentelemetry/exporter-trace-otlp-http/v/0.223.0) | Apache-2.0 | observability-standard：显式开启 OTLP/HTTP trace 导出                   | 与 2.12.0 系列兼容性；出口凭据、超时和失败降级；不默认联网                                              |

OTel 采用[官方 tracing/instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)和[exporter](https://opentelemetry.io/docs/languages/js/exporters/)路线。API、稳定 SDK 和 exporter 使用不同版本系列，不能强行统一版本号。首版日志走 stdout、指标走 Prometheus、trace 走 OTLP，避免同一信号重复维护两条出口。

MCP 使用[官方 v2 包划分](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md)：`createMcpHandler` 可直接处理 Web Request/Response，挂到已有 Hono，不再加 MCP 的 node/hono adapter。v1 `@modelcontextprotocol/sdk` 不列入新项目默认依赖。若 Grok 协议验收发现兼容问题，先确定具体 transport/版本差异，再提出精确的额外依赖，不能自动降级 dot 的 MCP 2.0。

## 2. 开发与构建依赖

| 包 / 固定版本                                                                              | 许可证声明 | 用途及边界                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| [typescript 7.0.2](https://www.npmjs.com/package/typescript/v/7.0.2)                       | Apache-2.0 | 类型检查、tsc 编译与声明输出；需确认本包在目标环境的实际编译器入口、与各工具的兼容，不仅看版本号 |
| [tsx 4.23.15](https://www.npmjs.com/package/tsx/v/4.23.15)                                 | MIT        | 开发运行/watch；不作为生产启动依赖；审计 esbuild 传递依赖/平台二进制                             |
| [vite 8.3.4](https://www.npmjs.com/package/vite/v/8.3.4)                                   | MIT        | 显式固定 Vitest 必需 peer，避免自动补齐浮动                                                      |
| [@types/ws 8.18.2](https://www.npmjs.com/package/@types/ws/v/8.18.2)                       | MIT        | WebSocket 类型边界                                                                               |
| [vitest 5.0.3](https://www.npmjs.com/package/vitest/v/5.0.3)                               | MIT        | core/Storage 共同契约及 HTTP/插件集成测试；不安装 UI/browser 扩展                                |
| [@types/node 26.6.5](https://www.npmjs.com/package/@types/node/v/26.6.5)                   | MIT        | 与 Node 26 运行时对齐                                                                            |
| [@types/better-sqlite3 9.6.0](https://www.npmjs.com/package/@types/better-sqlite3/v/9.6.0) | MIT        | SQLite 插件类型；版本系列不等于驱动系列，需编译验收                                              |
| [@types/pg 8.23.1](https://www.npmjs.com/package/@types/pg/v/8.23.1)                       | MIT        | PostgreSQL 插件类型                                                                              |
| [pnpm 12.11.2](https://www.npmjs.com/package/pnpm/v/12.11.2)                               | MIT        | workspace/packageManager 固定工具版本，不是产品运行时依赖                                        |

工具链更新：已按用户要求移除 Biome，使用 [Oxlint 1.87.0](https://www.npmjs.com/package/oxlint/v/1.87.0)、[Oxfmt 0.72.0](https://www.npmjs.com/package/oxfmt/v/0.72.0)、[oxlint-tsgolint 7.0.2004](https://www.npmjs.com/package/oxlint-tsgolint/v/7.0.2004)，均声明 MIT，已锁定 tarball integrity。前两者要求 Node ^20.19.0 或 >=22.12.0；当前 Node 26 满足。类型检查后端通过精确固定的可选平台包分发；三者无 install/postinstall hook。规则取舍、pre-commit 和 CI 验证见 [代码质量](CODE_QUALITY.md)。

暂不增加 tsup、Turborepo、Nx、changesets 或独立 testkit。先用 pnpm workspace + tsc 构建；正式独立发布多个包时再按需求审议发布工具。

## 3. 有意不引入的依赖

- Telegram 首版只用官方 Bot API 的文字/Webhook 路径，采用 Node fetch，不引入 grammY/Telegraf；错误、限流、分片和来源验证仍必须实现。
- 使用 Node 内建 crypto/randomUUID、AbortSignal、timer、AsyncLocalStorage，以及 JSON 配置/环境变量；不增加 axios、uuid、dotenv、cron 库或重试框架。重试依据数据库 due 状态。
- SQLite/PostgreSQL 直接 SQL，不引入 Prisma/Drizzle/Kysely 或迁移框架；插件在启动时幂等创建缺失的表和索引。
- 不引入 `@opentelemetry/sdk-node`、auto-instrumentations、OTel logs/metrics exporters、Sentry 或 pino-pretty。前者 registry 元数据带入大量当前不需要的 exporter；采用窄 tracing 模块。
- 不安装 Redis/BullMQ、Vercel/Cloudflare/D1 SDK，不恢复 Serverless 依赖。

可替代项供审计取舍：SQLite 可评估 Node 内建 node:sqlite 来减少第三方原生包，但须另行核实目标版本 API 状态及行为；Hono 可换 Node 原生 HTTP，但需自行处理路由适配；Zod 可换其他校验器，但 MCP 自身仍引入 Zod，未必减少依赖。以上不是同时安装的方案。

## 4. 全部原生渠道的依赖原则

本次全部 15 渠道实现。Telegram/Slack/Feishu/WhatsApp/Matrix/Google Chat/LINE/Mattermost/Teams 的 HTTP 路径优先 Node fetch + Zod 文档 schema；Discord/WeCom/DingTalk/QQ/Mattermost 的 WS 路径使用 ws 与严格协议 schema，IRC 用 node:net/tls，Signal 用 signal-cli 已公布的 JSON-RPC/SSE 文档。MCP 使用官方 SDK。各渠道实施前保存所依据的协议文档与测试契约，不凭记忆创造 wire schema。

Signal 明确依赖用户自行部署的非官方 signal-cli 服务，不冒充 Signal 官方 Bot API。Matrix 首次文字实现声明非加密房间范围，并显式诊断不支持的加密输入。WhatsApp 使用 Business Cloud API，不能复制 Web/Baileys transport。Teams/Google Chat 用 jose 验证官方 JWT/JWKS 规则，不能只解析 token。

不引入 OpenClaw、adapter-openclaw 或其外置插件为运行时依赖。参考仓库只提供平台行为与案例，复制代码时记录来源并保留许可。若某协议复杂度确需额外官方 SDK，代理必须先报告精确包名/版本/理由，根代理核实并更新清单/lockfile，不整体搬入上游依赖树。

## 5. 本轮核对的范围

已核对直接依赖的精确 registry 元数据和完整锁文件，完成安装、类型检查、构建、真实数据库及本地协议测试。生产图中的 56 个第三方包已逐项核查发布内容中的许可证；pg-types/pgpass 的许可位于 README，Standard Webhooks 的库许可与 Prometheus NOTICE 从各自发布 gitHead 补齐。完整文本随 Docker 镜像一起保留。pnpm audit 的已知漏洞结果及最终 CI 证据见 TODO；它仅反映核对时的公告库，不替代后续维护。依赖变更时应更新本清单、快照、lockfile 与许可声明。

Prometheus 客户端在实现时按官方 [v0.16.0 迁移发布](https://github.com/prometheus/client_js/releases/tag/v0.16.0) 改用 @prometheus-io/client@0.16.1。旧 prom-client 15.1.3 已在 npm 标弃用；新包支持 Node 26，许可证仍为 Apache-2.0，无 install/postinstall hook，保留现有依赖类型。原有 18 项可观测性测试不改断言即通过，另完成构建、类型检查；当前已安装树的 pnpm audit 未报告已知漏洞（仅此时点/此已安装树）。

MCP 协议验收新增开发依赖 [@modelcontextprotocol/client 2.3.1](https://www.npmjs.com/package/@modelcontextprotocol/client/v/2.3.1)（Apache-2.0，Node >=20）：官方 server 包不导出客户端，用真实客户端验证现代/legacy wire 协议。仅根 E2E 测试及 agent-dot/agent-grok 的 devDependencies 引入；生产包不加载该客户端。精确元数据、传递依赖和 integrity 已纳入快照与 lockfile，无 install/postinstall hook。
