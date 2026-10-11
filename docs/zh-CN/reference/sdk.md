# SDK v1 契约

[packages/sdk/src/index.ts](https://github.com/relanox/relanox/blob/master/packages/sdk/src/index.ts) 是稳定公共入口，模块按配置、消息、插件状态、存储、观测和 Host 划分。返回 Promise 的持久操作完成写入后才 resolve。时间为整数 Unix 毫秒，duration 为毫秒。JSON 可序列化、无 undefined，只携带平台协议 context，不暴露 SQL 或事务 callback。

## 装配与范围

每账号一个 ChannelPlugin 和 ChannelHost，账号 ID 全局唯一。setup 接收校验后的静态账号和插件配置。SecretRef 在装配/插件使用时解析，密钥不能进入请求快照。endpoint 快照保留原目标/options/引用，不保存解析值。凭据轮换改变引用变量值，绑定或目标修改不能重定向旧工作。Agent 每 kind 一个实例，setup 接收所属 endpoint 与全局配置，dispatch 接收冻结 endpoint 配置。

ChannelHost 固定账号，拒绝 source/target/channel 不匹配。Core 按账号/聊天/线程精确绑定，检查两层白名单并冻结目标/endpoint。AgentHost.forPrincipal 只在插件鉴权后调用，与该 Agent 配置 endpoint 取交集，正文不能扩张范围。StateStore 绑定插件/账号；Agent 订阅使用其 owner。路由由 Core 控制命名空间。Channel/Agent 不接收 Storage。

validateConfig 对非法 unknown 抛错，SDK 不泄露 Zod 类型。HTTP 使用 Web Request/Response，setup 注册 handler 不监听。长连接 start 在初始化后返回，stop 关闭连接。capabilities 声明文字单位与持久幂等；Core 按其限额分片后提交 outbound。send 一次接收一个持久分片，必须复用 idempotencyKey/state。协议序号通过命名空间 StateStore CAS 在外部效果前分配；chunk state 用于完成时不可变准备。

## 媒体契约

`MediaUpload` 携带内存字节、类型、MIME、文件名及可选时长/预览 ID。`MediaReference` 增加请求所属 UUID、字节数与 SHA-256，快照和结果只保存引用。`StoredMedia` 组合引用与字节。`ChannelPlugin.capabilities.media` 明确声明接收/发送的类型。Core 读取并校验 `SendInput.media` 和可选 `preview`，媒体分片的文字为空；适配器仍须遵守原生格式与权限限制。

`Storage.acceptInbound(snapshot, media)` 原子提交字节与入站快照。`Storage.media.put` 在同一事务检查 Agent endpoint 范围、当前 claim、上传身份和总预算；UUID、元数据、字节相同可重放，修改则冲突。`get` 限定在请求内。Agent Host 读取/上传要求当前 claim，complete 接收同一请求所属的有序 ID。Storage 检查结果引用与 outbound 分片一致，保留分片恢复能力；cleanup 移除符合条件的字节/元数据，保留重放与冲突判断的墓碑信息。

可选 `ChannelHost.media.publish` 签发限定账号与请求、持久且会过期的 URL。`mountHttp` 只有提供正文缓冲前授权 callback 才能申请更大的有界正文。Agent 二进制路由使用此能力校验签名传输 URL，普通路由保留原限额。见[媒体传输](../media.md)。

## 存储事务

### 接纳与领取

acceptInbound 以 channel/account/eventId 唯一去重。即使重放调用提供不同新 ID，也返回原 requestId。pending 初始 version=1，dispatch dueAt=acceptedAt，attempts=0。记录为深序列化快照，调用者修改对象不影响持久值。

listPending 在 endpointIds 范围内按 acceptedAt/requestId FIFO 返回有界 pending 快照。claimRequest 原子检查范围和 endpoint 排他。已有 claim 或已开始通知占据 endpoint，直到完成或显式恢复；有 dispatch lease、非零 attempts、unknown/rejected dispatch 即为开始。新请求不能通过更早时间/ID 抢占。未开始请求只有 FIFO 首项可领取。

相同 request/claimKey 返回原 token，replay=true；不同 key 或另一个活跃 claim 返回 busy；completed/failed 返回 not_pending。token 由 Core 安全随机产生，直到最终结算或显式 requeue 有效，不因超时过期。

### 完成与失败

completeAndEnqueue 校验授权范围和当前 token，在同一事务提交唯一 final 与 outbound，释放 endpoint 串行占用。相同 resultId/text 且 token 有效时重放返回原 deliveryId、replay=true；相同 resultId 但文字不同或第二个 final 冲突。

outbound 必须指向该 request/result 与冻结 target，currentChunk=0、receipts 为空、status=pending、version=1。Storage 检查这些不变量，不信任调用者目标。resultId 全局唯一。fail 检查范围/token 并保存终态 error，重复匹配失败幂等。下一请求自行变得可领取，不依赖内存唤醒。

### Lease 与发送结算

takeDue 原子获取 token/version/expiresAt lease 并推进持久 version。dispatch 只选择 endpoint 最早未完成 pending 请求；claimed 阻塞后续请求且不 dispatch。accepted dispatch 在 nextDueAt 仍可通知未领取请求，限额由 Core 决定。pull endpoint 不参与自动 dispatch。并发工作者不能领取同一未过期 lease。

过期 lease 意味外部效果不确定。过期 dispatch 变 unknown；过期 send 除 safeRetryAccountIds 可用原持久 key 重试外也变 unknown。unknown 不自动选择。settleAttempt 检查精确 token/version，不覆盖新 claim/final/requeue，清 lease 并更新 attempts/outcome。

成功分片在一个事务追加回执、推进 currentChunk、重置 attempts=0；attempts 按当前分片，不包含已经成功的分片。全部发送才标为 sent。retryable 保留 index/identity，rejected/unknown 停止自动发送。Core 决定 nextDueAt 和有界 retryAfterMs；claim/final/requeue 撤销 dispatch lease。

### 显式恢复

requeue 要求当前精确版本。request 可恢复 claimed/failed/dispatch-rejected/dispatch-unknown，撤销 token/final failure 并重设 dispatch due；completed 或已脱敏请求不允许重跑。delivery 可恢复 rejected/unknown，保留已发分片/回执，为新预算重置 attempts，并从 currentChunk 继续。unknown 要求 acknowledgeUnknown=true，表示接受重复外部效果风险，不代表远端取消。

### 协议状态 CAS

expectedVersion=null 只允许新建。成功写入从 1 单调增加，包括删除后重建。删除要求精确版本，保留不可见 version fence，不保留 value；读取/列表视为缺失，重建必须 expectedVersion=null。pluginId/ownerId/key tuple 唯一。

State list 按 key 排序，expiresBefore 只选 expiresAt <= 边界，prefix 与 expiry 可组合。value 是序列化快照。

### 管理、保留与生命周期

管理 list 各自应用相关 status 和可选 endpoint 范围，按 ID 排序，afterId 为排他游标。getStats 用数据库聚合：unknown 计 pending 中 unknown dispatch 与 unknown delivery；持久 claim 消除通知不确定性；undelivered 计 pending/rejected/unknown delivery。无待处理项时 oldestPendingAt 缺失。

cleanup 只在对应 outbound 已 sent 且旧于 before 时脱敏 completed 的 text/context；足够旧的 failed 也可脱敏。保留 source 去重键、final 身份及重放/冲突所需最小结果摘要/相等信息，绝不清理未完成或未送达工作。redactedAt 标记空 text/context tombstone。实现可内部保留摘要，不新增业务表。

initialize 幂等创建缺失表/索引并保留记录；每次启动先 initialize 再 health。health 只检查必需表与连接。close 释放资源，正确性不依赖 close 刷盘。

Storage 用 union 表达业务结果，驱动/I/O 失败 reject，上游因此不能 ACK。版本与 lease 约束本地持久化，不提供远端恰好一次。

## 观测

观测同步且尽力，facade 隔离导出失败。日志只接收 LogFields，指标标签不能是 request/user/chat ID。Span 可提供可序列化 context 供持久关联，短执行且只结束一次。context 仅供关联，不授予权限。noopObservability 是生产禁用选项。指标 handler 由 CLI 挂在管理 listener，不自动公开。完整配置见 [可观测性](observability.md)。
