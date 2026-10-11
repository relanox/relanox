# 可观测性

Core 和原生插件只通过 SDK host.observe 或注入 facade 观测。装配使用 `@relanox/observability-standard` 的 createStandardObservability：校验配置、setup、把 runtime.observe 交给 Core/Storage/Channel，并把可选 runtime.metrics 私下挂在管理 listener。

## 字段与范围

日志 event 是有限集合：inbound.accepted/duplicate/rejected、dispatch.completed、message.queued、media.read、delivery.completed、retry.scheduled、delivery.unknown、connection.changed、worker.completed、storage.failed、recovery.completed、retention.completed、startup.completed、shutdown.completed、operation.failed。未知 event 归为 operation.failed，不能写任意错误或消息字符串。

span/operation 为 ingest、dispatch、enqueue_message、read_media、send、storage、http、worker、connection、recovery、retention、startup、shutdown。outcome 为 ok、error、accepted、duplicate、rejected、retryable、unknown、sent、conflict、unauthorized、connected、disconnected、degraded、stale、not_found、queued、updated。

plugin 只允许 core、cli、storage-sqlite/postgres、observability-standard、agent-dot/grok 和十五个 channel 插件；channel/agent 使用 SDK 固定 ID。账号、endpoint、用户、聊天、请求 ID 不允许作为指标标签；未知 label key/value 丢弃整次观测，每个指标每 runtime 最多 64 个标签 tuple。

通用 errorCode/error_class 为 timeout、network、authentication、authorization、rate_limit、invalid_input、conflict、storage、unsupported、unavailable、unknown、internal。日志还接受 Core 的 call_timeout、retry_budget_exhausted、invalid_chunk_index、plugin_missing、plugin_exception、invalid_plugin_outcome、storage_unavailable、not_accepting、worker_failed。平台错误映射通用类别，详细有界协议码只留业务结果记录，不进入日志。

日志白名单为 plugin/requestId/deliveryId/traceId/errorCode/outcome/operation。request/delivery ID 只接受 UUID，trace ID 为 32 位 hex，不序列化正文、密钥、任意对象、free text 或 Error。Pino 不输出默认 hostname/pid。

原生诊断事件有显式有限映射：channel_policy_rejection、channel_input_discarded、channel_unsupported_input、channel_unsupported_sender、channel_event_ignored、channel_invalid_frame 变为 inbound.rejected；channel_connection_replaced 变为 connection.changed；receive 变 ingest。sender_not_allowed 映射 authorization，encrypted_unsupported 映射 unsupported，bot_connection_replaced 映射 conflict。不按前缀推断或保留任意平台码，新调用使用通用词汇。

## Standard 配置

配置是严格对象：

| 字段                       | 默认值               | 范围/含义                                                        |
| -------------------------- | -------------------- | ---------------------------------------------------------------- |
| logs                       | true                 | JSON Pino 日志                                                   |
| level                      | info                 | debug/info/warn/error                                            |
| metrics                    | true                 | false 时无指标 handler                                           |
| processMetrics             | true                 | 独立 registry 的 CPU/内存/事件循环指标                           |
| logBufferBytes             | 65536                | 整数 1024–1048576，背压等待队列                                  |
| lifecycleTimeoutMs         | 3000                 | 整数 100–10000                                                   |
| tracing                    | 缺省                 | 显式启用对象，无默认 endpoint/环境激活                           |
| tracing.endpoint           | 必需                 | 完整 OTLP HTTP trace URL；http/https，无 userinfo/query/fragment |
| tracing.sampleRatio        | 0.1                  | 0–1                                                              |
| tracing.maxQueueSize       | 512                  | 整数 1–4096                                                      |
| tracing.maxExportBatchSize | min(128, queue size) | 整数 1–queue size                                                |
| tracing.scheduledDelayMs   | 1000                 | 整数 100–10000                                                   |
| tracing.exportTimeoutMs    | 2000                 | 整数 100–10000                                                   |

metrics handler 使用 Web Request/Response，只接受 GET/HEAD，其余 405；不监听、不鉴权、不选择 bind 地址。flush(signal) 与幂等 shutdown(signal) 等待已接纳日志回调，受 signal 和本地期限限制。调用方拥有 logDestination Writable，关闭前保持存活；插件不结束 stdout/collector stream，期限到达仍可能有未完成日志。

stdout 返回 false 时队列最多 logBufferBytes，溢出丢弃并计数，destination 失败被吸收。未知指标、负/非有限值或错误调用类型忽略；未知 label 丢弃，缺失标签显示 none。不注册全局 registry。

## 指标

业务标签为 channel/agent/plugin/operation/outcome/error_class，全部取有限集合。

| 调用/指标                                            | 含义                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| count relanox_inbound_total                          | 接纳/重复/拒绝                                    |
| count relanox_dispatch_total                         | 短通知结果                                        |
| count relanox_delivery_total                         | 持久分片发送结果                                  |
| count relanox_retries_total                          | dispatch/send 的本地重试观测                      |
| record relanox_http_duration_seconds                 | HTTP 操作秒数                                     |
| record relanox_storage_duration_seconds              | 存储操作秒数                                      |
| record relanox_dispatch_duration_seconds             | dispatch 秒数                                     |
| record relanox_send_duration_seconds                 | send 秒数                                         |
| record relanox_reply_duration_seconds                | 入站接纳到回复入队秒数                            |
| record relanox_delivery_duration_seconds             | 消息入队到送达秒数                                |
| record relanox_pending/outbound/unknown              | getStats 快照 gauge                               |
| record relanox_oldest_pending_age_seconds            | 最老 pending 年龄，成功空快照才归零               |
| record relanox_storage_stats_stale                   | 刷新失败 1，成功 0，失败保留其他 gauge            |
| record relanox_worker_last_success_timestamp_seconds | 成功循环 Unix 秒时间                              |
| record relanox_connection_status                     | plugin 聚合，connected=1，disconnected/degraded=0 |
| relanox_telemetry_dropped_total                      | 内部丢弃计数，signal 为 logs/metrics/traces       |

duration histogram 桶为 0.005、0.025、0.1、0.5、1、5、30、120、600、3600、+Inf 秒。counter 是进程观测，重启归零；gauge 是快照，不是业务事实。收集 metrics 不访问存储或写业务状态。Core 负责存储轮询、新鲜度和健康；readiness 不依赖 exporter。

## Trace 与失败隔离

Trace provider 是 runtime 本地对象，不全局注册 context manager/provider。Core 创建短 span，持久保存可选 W3C span.context 供后续关联；丢弃输入 tracestate，避免不透明密钥传播。重复 end 无效果。没有长远端任务 span、自动埋点、HTTP body、SQL、host/cloud 检测或 OTel 日志/指标导出。

导出错误不 reject 业务调用；SDK/exporter 可产生自身有界诊断，插件不递归记录导出失败。期限可丢失 telemetry，不影响数据库持久化。只有配置 tracing.endpoint 才激活 OTLP；激活后上游可读取 OTEL_EXPORTER_OTLP_HEADERS/OTEL_EXPORTER_OTLP_TRACES_HEADERS 作 collector 鉴权，按部署密钥管理。

观测同步尽力，不是业务状态。noopObservability 是支持的禁用 facade；CLI 可独立保留最小启动错误。健康检查在观测关闭或失败时仍工作。告警部署见 [运维](../operations.md)。
