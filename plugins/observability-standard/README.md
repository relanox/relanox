# Standard observability

`createStandardObservability()` returns the SDK plugin. Call `validateConfig(unknown)` and `setup(config)`, pass `runtime.observe` to core/storage/channels, and mount `runtime.metrics` exclusively on CLI's management listener. The handler does not listen, authorize, or select a bind address. It accepts GET/HEAD; other methods return 405. `flush(signal)` and idempotent `shutdown(signal)` honor an abort signal and a local deadline. The application owns any supplied `logDestination` Writable and must keep it alive until shutdown; the plugin never ends stdout or the collector stream.

Configuration is a strict object:

| Field | Default | Bounds/meaning |
| --- | --- | --- |
| logs | true | boolean; JSON Pino output |
| level | info | debug/info/warn/error |
| metrics | true | boolean; handler omitted when false |
| processMetrics | true | boolean; CPU/memory/event-loop metrics in independent registry |
| logBufferBytes | 65536 | integer 1024..1048576; pending queue during backpressure |
| lifecycleTimeoutMs | 3000 | integer 100..10000 |
| tracing | omitted | opt-in object, no default endpoint or environment activation |
| tracing.endpoint | required | explicit full OTLP HTTP trace URL; http/https, no userinfo/query/fragment |
| tracing.sampleRatio | 0.1 | 0..1 |
| tracing.maxQueueSize | 512 | integer 1..4096 |
| tracing.maxExportBatchSize | min(128, queue size) | integer 1..queue size |
| tracing.scheduledDelayMs | 1000 | integer 100..10000 |
| tracing.exportTimeoutMs | 2000 | integer 100..10000 |

Trace providers are local to each runtime, never registered globally. Core calls explicit short spans and stores `span.context` as an optional durable parent for later stages. Incoming tracestate is discarded to prevent opaque secret propagation. Calling end twice has no additional effect. No long remote-work spans, auto-instrumentation, SDK-node, HTTP body, SQL, host/cloud detection or OTel log/metric export is installed. Export errors do not reject business calls. SDK/exporter may emit its own bounded internal diagnostic behavior; plugin does not recursively log export failures. Export/exit deadlines may lose telemetry without affecting database durability.

Only exported `events`/`operations`, known plugin IDs and fixed outcome/error categories are output; unknown event becomes `operation.failed`, other unknown fields/categories are dropped. requestId/deliveryId accept generated UUIDs only; traceId accepts 32 hex digits. Error objects and free text are never serialized. Callers should map their detailed error codes to the listed categories. Pino base hostname/pid fields are disabled. When stdout returns false, at most logBufferBytes are queued; overflow is dropped and counted, and destination failures are absorbed.

All business metrics use SDK labels channel/agent/plugin/operation/outcome/error_class. Values are fixed known channels/agents/plugin IDs and operation/outcome/error categories exported/defined in source. Missing labels appear as `none`; unknown keys/values reject the observation. Each metric accepts at most 64 distinct label tuples per runtime to prevent multiplication of finite vocabularies. Unknown metric names, negative/nonfinite values and wrong method types are ignored. No request/user/chat/account/endpoint label exists. No global registry registration occurs.

| SDK call / metric | Meaning |
| --- | --- |
| count relanox_inbound_total | channel/outcome accepted, duplicate, rejected |
| count relanox_dispatch_total | agent/outcome of short notification |
| count relanox_delivery_total | channel/outcome of persisted chunk send |
| count relanox_retries_total | operation dispatch/send; local retry observations |
| record relanox_http_duration_seconds | seconds; bounded HTTP operation |
| record relanox_storage_duration_seconds | seconds; storage call |
| record relanox_dispatch_duration_seconds | seconds; dispatch call |
| record relanox_send_duration_seconds | seconds; send call |
| record relanox_result_duration_seconds | seconds; acceptance to committed result |
| record relanox_delivery_duration_seconds | seconds; committed result to delivery |
| record relanox_pending / relanox_claimed / relanox_outbound / relanox_unknown | gauges set from Storage.getStats |
| record relanox_oldest_pending_age_seconds | current age, zero only after successful empty snapshot |
| record relanox_storage_stats_stale | 1 when refresh fails, 0 after success; retain other previous gauges on failure |
| record relanox_worker_last_success_timestamp_seconds | Unix seconds of successful loop, permits external freshness alert |
| record relanox_connection_status | plugin label; connected=1, disconnected/degraded=0 |
| relanox_telemetry_dropped_total | internal counter with fixed signal logs/metrics/traces |

Duration histograms have seconds buckets 0.005, 0.025, 0.1, 0.5, 1, 5, 30, 120, 600, 3600 and +Inf. Counters are process observations and reset on restart. Gauges are snapshots, never business facts. Collecting metrics does not access storage or write business state. Core owns freshness, health and storage polling. Readiness must not depend on collectors or this plugin. `noopObservability` from SDK is the disabled alternative; CLI may retain minimum startup errors independently.

Known core diagnostic log codes are also allowed verbatim: call_timeout, retry_budget_exhausted, invalid_chunk_index, plugin_missing, plugin_exception, invalid_plugin_outcome, storage_unavailable, not_accepting, worker_failed. Generic error_class metric labels remain the fixed categories timeout/network/authentication/authorization/rate_limit/invalid_input/conflict/storage/unsupported/unavailable/unknown/internal. OTLP is activated exclusively by this configuration's endpoint; when activated, the upstream exporter may honor its standard OTEL_EXPORTER_OTLP_HEADERS/OTEL_EXPORTER_OTLP_TRACES_HEADERS environment settings for collector authentication. Treat those variables as deployment secrets.
