# SDK v1 契约

[packages/sdk/src/index.ts](https://github.com/relanox/relanox/blob/master/packages/sdk/src/index.ts) 是稳定公共入口，模块按配置、消息、插件状态、存储、观测和 Host 划分。返回 Promise 的持久操作完成写入后才 resolve。时间为整数 Unix 毫秒，duration 为毫秒。JSON 可序列化、无 undefined，只携带平台协议 context，不暴露 SQL 或事务 callback。

## 装配与范围

每账号一个 ChannelPlugin 和 ChannelHost，账号 ID 全局唯一。setup 接收校验后的静态账号和插件配置。SecretRef 在装配/插件使用时解析，密钥不能进入请求快照。endpoint 快照保留原目标/options/引用，不保存解析值。凭据轮换改变引用变量值，绑定或目标修改不能重定向旧工作。Agent 每 kind 一个实例，setup 接收所属 endpoint 与全局配置，dispatch 接收冻结 endpoint 配置。

ChannelHost 固定账号，拒绝 source/target/channel 不匹配。Core 按账号/聊天/线程精确绑定，检查两层白名单并冻结目标/endpoint。AgentHost.forPrincipal 只在插件鉴权后调用，与该 Agent 配置 endpoint 取交集，正文不能扩张范围。StateStore 绑定插件/账号；Agent 订阅使用其 owner。路由由 Core 控制命名空间。Channel/Agent 不接收 Storage。

validateConfig 对非法 unknown 抛错，SDK 不泄露 Zod 类型。HTTP 使用 Web Request/Response，setup 注册 handler 不监听。长连接 start 在初始化后返回，stop 关闭连接。capabilities 声明文字单位与持久幂等；Core 按其限额分片后提交 outbound。send 一次接收一个持久分片，必须复用 idempotencyKey/state。协议序号通过命名空间 StateStore CAS 在外部效果前分配；chunk state 用于消息入队时不可变准备。

## 媒体契约

`MediaUpload` 包含内存字节、kind、MIME、文件名及可选时长/预览 ID。`MediaReference` 增加请求所属 UUID、大小与 SHA-256；快照和出站消息只存引用，`StoredMedia` 配对引用和字节。渠道能力显式声明接收/发送种类。Core 在发送前解析 `SendInput.media` 和可选 preview，媒体分片文字为空，渠道继续检查原生格式与权限。

`Storage.acceptInbound(snapshot,media)` 原子保存入站字节与快照。`ScopedAgentHost.media.read({requestId,mediaId})` 按 Agent endpoint 授权，不需要任务 token。`sendMessage({replyTo,text,idempotencyKey?,attachments?})` 接收已有媒体 ID、内存 `MediaUpload` 或生成的 `{media,preview}` 对。Storage 的 `enqueueMessage` 在同一事务校验 request/agent/endpoint 与冻结目标，保存生成媒体、消息身份和出站分片；预览与正文媒体属于同一输入。没有独立 Agent 上传操作。

`ChannelHost.media.publish` 可为本账号/请求生成持久过期 URL。`mountHttp` 的较大请求体限制必须配合缓冲前授权。Agent 二进制下载路由使用签名 GET URL，其他路由保持普通限制，详见[媒体](../media.md)。

## 存储事务

- `acceptInbound` 按 channel/account/eventId 去重，重放返回原 requestId。新记录只有 snapshot、version=1、dispatch 与可选 redactedAt，dispatch 为 due、dueAt=acceptedAt、attempts=0；调用方修改对象不能改变已保存值。
- `enqueueMessage` 校验不可扩大的 Agent/endpoint 范围、输入可用性、消息身份、冻结目标及分片/媒体一致性，原子保存所有新附件与一个 outbound。相同身份与内容返回原 deliveryId、replay=true，改变内容冲突。outbound 使用 messageId、version=1、pending、currentChunk=0 和空回执。同一输入可关联多条独立消息。
- `takeDue` 原子获取短 token/version/expiresAt lease 并推进版本，按持久时间/身份选择到期工作。同 endpoint 的不同输入互不阻塞；同输入的回复按持久插入顺序，仅选择最早 pending 发送，前序 unknown 阻止后序直到手动恢复，rejected 放行后序。accepted 通知为终态，只有 due 通知和 pending 发送自动选择；并发工作者不能获取同一未过期 lease。
- dispatch lease 过期变 unknown。send 过期也变 unknown，除 safeRetryAccountIds 允许复用原分片身份重试。`settleAttempt` 要求准确 lease token/version，不覆盖新结算或 requeue，清 lease 并记录 outcome。成功分片追加回执、推进 currentChunk、重置当前分片 attempts=0；全部发完才为 sent。retryable 保留身份，rejected/unknown 停止自动副作用。
- `requeue` 要求当前版本。未脱敏的 accepted/rejected/unknown 通知可重设 due；rejected/unknown delivery 保留成功分片和回执，重置当前重试预算并继续 currentChunk。unknown 必须 acknowledgeUnknown=true。通知恢复不取消远端工作或撤销回复权限。
- State CAS 的 expectedVersion=null 仅创建；版本从 1 开始并跨删除重建单调增长。准确版本删除保留不可见 version fence。pluginId/ownerId/key 唯一，列表按 key 排序并组合 prefix/expiry，过期条件为 expiresAt <= bound。状态值为序列化快照。
- 管理列表使用对应 dispatchStatus/deliveryStatus、可选 endpoint 范围和按 ID 的排他 afterId 游标。`getStats` 聚合 pending **到期通知**、pending/rejected/unknown 未送达消息与 unknown 通知/发送效果；没有 claimed 统计，无到期通知时省略 oldestPendingAt。
- cleanup 脱敏符合条件的旧内容、删除符合条件的媒体，保留 source 去重与消息相等摘要。保护 due/unknown 通知与全部未送达 outbound。redactedAt 标记空 text/context tombstone，已脱敏输入不能接纳新回复。
- `initialize` 幂等创建当前 schema。非空旧任务 schema 拒绝启动并提示备份/导出，不会静默解释旧工作。`health` 只检查表与连接，`close` 释放资源，正确性不依赖关闭时刷新。

Storage 返回有类型的业务 outcome union；驱动/I/O 错误 reject，入站不能 ACK。版本与 lease fence 保护本地状态，不保证外部效果恰好一次。

## 观测

观测同步且尽力，facade 隔离导出失败。日志只接收 LogFields，指标标签不能是 request/user/chat ID。Span 可提供可序列化 context 供持久关联，短执行且只结束一次。context 仅供关联，不授予权限。noopObservability 是生产禁用选项。指标 handler 由 CLI 挂在管理 listener，不自动公开。完整配置见 [可观测性](observability.md)。
