# 架构

Relanox 是常驻消息网关：将渠道文字和媒体持久交给已有的 dot 或 Grok Bot，再把异步最终结果发回原会话。它不运行模型。[配置](configuration.md) 控制部署，[Core](reference/core.md) 和 [SDK](reference/sdk.md) 定义运行与持久契约。

## 组件

渠道 → Core → Agent → 托管 dot/Grok；Core ↔ Storage；CLI 管理生命周期；Observability 记录本地阶段。

| 组件          | 职责                                                                |
| ------------- | ------------------------------------------------------------------- |
| SDK           | 基础值、配置、消息、Host 和插件契约                                 |
| Core          | 授权、精确绑定、去重、领取、结果关联、重试决策、HTTP 路由和单批工作 |
| Channel       | 平台鉴权、输入规范化、独立发送和回执                                |
| Agent         | 托管 Agent 鉴权/传输、MCP 工具和通知                                |
| Storage       | 表、索引、快照和持久原子操作                                        |
| Observability | 日志、指标和短本地 trace                                            |
| CLI           | 具体插件装配、HTTP listener、工作循环、连接和管理                   |

Core 和插件依赖 SDK，CLI 装配具体实现。渠道和 Agent 只接收限定范围的 Host 与命名空间协议状态，不直接接收 Storage。Storage 执行原子条件，Core 决定业务转换。

`channel-media` 依赖 SDK 契约和共享的 `transport` 基础实现。媒体授权、发布与持久化仍由 Core 和 Storage 负责；各渠道保留平台原生的上传下载协议。

`agent-mcp` 负责 dot 和 Grok 共用的 MCP 配置、鉴权、任务工具、媒体传输凭证与请求投影，只依赖 SDK 契约和 MCP 服务端库，不依赖 Core 或具体 Agent 插件。dot 保留订阅与 webhook 通知，Grok 保留 Routine 分发。共享包是实现库，不作为插件注册进 CLI 目录。

`transport` 共享 HTTP 请求体读取、限时请求、签名校验、WebSocket 辅助和公网地址分类；平台错误映射、凭据策略与 DNS 信任决策仍由调用方负责。`storage-support` 在两个数据库插件间共享持久 JSON 编码、结果/媒体摘要和记录/媒体条件判断，SQL、事务与数据库特有的解码保留在各后端。

## 持久消息流

数据库中，`inbound` 保存请求、冻结快照、领取令牌和通知进度；`outbound` 保存最终文字/媒体分片、发送进度与回执；`media` 保存请求所属的字节和元数据；`plugin_state` 在独立命名空间内保存订阅、游标与发布凭证。二进制在内存中跨插件边界传递，不进入 JSON 快照。共享 `@relanox/channel-media` 包负责渠道的有界远程下载与上传辅助，Core 负责请求授权、附件顺序与公开发布。

1. 渠道鉴权事件。Core 检查发送者白名单和精确账号/聊天/线程绑定，提交后才确认接收。去重使用渠道、账号和稳定平台事件 ID。
2. 接纳时冻结 endpoint、凭据引用和可序列化回复目标。绑定改变不能重定向旧请求；Agent 不能指定其他目标。
3. 工作循环领取到期工作。Grok 收到 Routine 正文，dot 收到通知后经 MCP 读取请求。短 dispatch 不等待远端任务。
4. 鉴权后的 Agent 在 endpoint 范围领取。每个 endpoint 只有一个活跃请求；同 claimKey 重放返回同一个持久 token。
5. 完成校验 token，在同一事务提交最终结果与 outbound。相同完成重放幂等，不同最终结果冲突。
6. 渠道向冻结目标发送分片并保存回执。已知临时失败可重试；模糊发送停止自动效果并要求显式恢复，除非渠道声明足够的发送幂等能力。

短 lease token 和版本阻止过期本地结算，不能撤销已发送网络请求。长期 claim 重启后保持，不因超时释放。显式 request requeue 撤销旧 token。外部效果恰好一次取决于平台幂等/查询能力。

Storage 是持久工作的唯一事实源，不需要独立队列。启动继续推进已提交工作。没有重放协议的连接不能保证恢复断线期间消息。保留清理不删除未完成请求、未送达结果和必要去重信息。

## 生命周期与安全

每个实例选择一个权威 SQLite 或 PostgreSQL。启动校验全部插件配置、初始化缺失 schema、检查存储、注册 handler、启动连接和工作循环。诊断只读；关闭先停止接收，再在总预算内结束短调用。

渠道与 Agent 分别鉴权，消息正文不授予权限。凭据在使用时解析环境引用，不写入持久请求快照或日志。dot callback 校验精确授权、DNS 地址策略并拒绝重定向。HTTP 和外部调用都有大小与期限限制。

业务 MCP/webhook 通过 HTTPS 提供，管理使用独立的字面量回环 listener。观测失败不阻断持久工作；日志排除正文和密钥，指标标签为有限词汇。trace 只关联本地交接，不覆盖远端推理。见 [可观测性](reference/observability.md) 和 [运维](operations.md)。

## 源码职责

包入口是稳定公共边界。内部模块直接导入具体兄弟模块，不反向导入本包 `index.ts`。

| 位置                                 | 职责                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| `packages/sdk/src`                   | values/config/messages/state/storage/observability 和插件 Host |
| `packages/channel-media/src`         | 渠道有界下载、MIME 分类与原生上传辅助                          |
| `packages/agent-mcp/src`             | 托管 Agent 共用的 MCP 鉴权、任务工具、媒体传输与请求投影       |
| `packages/transport/src`             | 共享 HTTP、签名、WebSocket 与地址基础实现                      |
| `packages/storage-support/src`       | 持久值编码、摘要与存储条件判断                                 |
| `packages/core/src/config`           | 配置结构、引用关系、插件校验和路由索引                         |
| `packages/core/src/hosts`            | 渠道/Agent 授权 Host、命名空间、连接观测和 setup               |
| `packages/core/src/worker`           | 有期限的顺序执行、结果校验和重试策略                           |
| `packages/core/src/runtime.ts`       | Core 装配、HTTP、工作和管理                                    |
| `plugins/channel-*/src`              | 纯 config/schema、账号运行对象、传输和连接状态                 |
| `plugins/agent-*/src`                | 每 endpoint 配置、凭据、MCP 与通知/Routine 传输                |
| `plugins/storage-*/src`              | 数据事务、请求、lease、协议 CAS、查询和编码                    |
| `plugins/observability-standard/src` | 配置、脱敏、背压、指标、trace 和生命周期                       |
| `apps/cli/src`                       | 应用配置、插件目录、listener、工作生命周期和管理命令           |

维护和验证方法见 [开发指南](development.md)。本地协议对端与真实存储测试保护契约，不证明真实账号兼容性。
