# Core 装配 API

`@relanox/core` 只依赖 SDK、Hono 和 Zod。`createCore` 接收 `{config,storage,channels,agents,observe?,worker?}`，不创建/初始化存储、不建立 listener/timer、不解析凭据、不启停插件。CLI 在 run 时初始化并检查存储、装配插件、创建 Core、以进程 AbortSignal 启动连接并定期调用 processDue。诊断只检查存储；关闭设置 accepting=false，停止循环/连接，释放存储与有期限的观测导出。

## 插件装配与配置

channels 是以配置账号 ID 为 key 的 ReadonlyMap，每账号一个 ChannelPlugin；agents 以 dot/grok 为 key，每种一个实例。装配时插件泛型擦除为 unknown，但工厂仍校验各自 schema。metadata 必须符合配置 kind、SDK major 1 和 node runtime。任何 setup 前完成全部账号和每 endpoint 校验。

账号 setup 接收解析后的插件配置与原始静态账号副本；Agent setup 接收全部原始 endpoint 和第三参数 `{}`，每 endpoint 的 validateConfig 不把它当 Agent 全局配置。dispatch 按需再次校验冻结 endpoint。

`validateConfig(unknown)` 校验严格 SDK JSON。ID 是安全 URL 段，引用存在、绑定 tuple 唯一、发送者白名单显式非空。无匹配绑定拒绝；账号和可选绑定白名单必须同时允许。没有线程回退或通配符。配置只包含静态 JSON，凭据字段要求 SecretRef。`secretRefSchema` 和 `resolveSecretRef(ref,environment)` 支持装配/插件在使用时解析，Core 不读取 process.env。

Core 持久保存原始 endpoint JSON/options/SecretRef 和目标，不保存校验结果或解析后的密钥。插件不得将凭据放入 target.data/context。修改配置需要重建进程；旧工作保留原目标，仍解析当前引用的环境值。

## HTTP 与 Host

路由挂在 `/channels/<accountId><path>` 与 `/agents/<agentId><path>`；`/` 表示命名空间根。渠道 `/webhook` 得到 `/channels/bot/webhook`；Agent `/mcp` 得到 `/agents/grok/mcp`。handler 接收包含前缀的完整 URL。路径只允许安全字面段与末尾 `*`，不允许遍历/query/fragment；重复路由拒绝 setup。

Core 路由错误返回脱敏 500。正文按原始字节缓冲，受 maxHttpBodyBytes 限制，包括 chunked/伪造 Content-Length；超限 413，不完整正文到 callTimeoutMs 返回 408，不解码或重序列化签名输入。插件在调用 Host 前鉴权并实施协议限额。管理健康/指标由 CLI 独立 listener 提供，不属于业务 fetch API。

ChannelHost 固定 source/target 的账号和渠道，校验有界 Unicode 文字、可序列化 context、白名单和绑定，等待 acceptInbound 后返回。稳定事件去重由 Storage 执行。AgentHost.forPrincipal 将鉴权 endpoint 与配置 Agent endpoint 取交集，去重并拒绝范围扩张；仅可在协议鉴权后调用。

listPending/claim/complete/fail 使用不变授权范围。claim 生成安全随机 token，Storage 用 claimKey 实现重放。complete 的 getInbound 只用于构造冻结目标/分片；completeAndEnqueue 原子重查范围、token 和最终唯一性，不接受回复目标。对外工具只能投影安全字段，不能暴露含私有 URL/SecretRef 的 endpoint.config。

`chunkText(text,max,unit)` 支持 UTF16、codepoints 和 UTF8 字节，不拆 Unicode scalar；孤立 surrogate 或单 scalar 无法容纳时拒绝。分片 idempotencyKey 为 `<deliveryUUID>:<index>`，state 为 null。需要协议序号的插件在外部发送前通过绑定 StateStore CAS 分配，重试复用已分配序号和持久分片身份。命名空间由 metadata ID 与账号/Agent kind 决定，不由调用者指定。

## 工作批次

processDue 运行一个有界顺序批次，阻止同 runtime 重叠。Storage FIFO 选择 endpoint 工作并原子领取 lease，Core 无内存队列。一次只领取一项，避免慢调用耗尽已排队工作的 lease。dispatch 接收冻结原配置；send 接收单个持久分片与目标。

调用带 signal 和超时竞争；异常、非法结果、超时变为 unknown，停止自动效果。声明 idempotentSend 的账号可安全恢复过期发送，复用原分片 key。settleAttempt 接收精确 lease token/version；并发 claim/final/requeue 可使结算冲突。中止不能撤销外部效果，插件须遵守 signal。

| Worker 选项            | 默认值  |
| ---------------------- | ------- |
| batchSize              | 32      |
| batchDurationMs        | 30000   |
| callTimeoutMs          | 10000   |
| leaseMs                | 30000   |
| maxAttempts            | 8       |
| retryBaseMs            | 1000    |
| retryMaxMs             | 300000  |
| notificationIntervalMs | 60000   |
| maxTextBytes           | 1048576 |
| maxContextBytes        | 65536   |
| maxHttpBodyBytes       | 2097152 |

lease 必须大于 timeout。retryable 延迟限定在 base/max 内，无显式延迟时指数退避。未领取的 accepted dispatch 在 notificationIntervalMs 后可再次通知。accepted/retryable 耗尽预算变为 rejected `retry_budget_exhausted`，保留工作供恢复。outbound 预算按当前分片计算，成功推进后重置。unknown 不自动恢复，claimed 不自动 dispatch 或超时释放。

## 管理与观测

status(filter?) 返回统计、请求/发送分页和连接组件。这是含正文的管理 API，CLI 不得公开 HTTP 暴露或记录日志。health 检查存储健康/连接并捕获驱动错误；readiness 还检查 accepting 和最近 worker 失败。渠道连接退化独立显示；CLI 负责监督循环与新鲜度。

cleanup({before,limit}) 校验有界参数后委托保留清理，不删除未完成/未送达工作。requeue({kind,id,expectedVersion,acknowledgeUnknown}) 使用精确版本恢复，不执行远端取消；unknown 必须显式确认。完整原子规则见 [SDK](sdk.md)。

observe 使用异常隔离 facade，有限计数器、秒制 duration、gauge 与 standard 观测一致，记录短 ingest/claim/complete/fail/dispatch/send span 和安全字段。ingest 持久保存本地/输入 span context，后续阶段关联。成功批次从真实 getStats 更新积压；失败保留旧值并标记 storage_stats_stale。导出失败不改变业务状态或 readiness。详见 [可观测性](observability.md)。
