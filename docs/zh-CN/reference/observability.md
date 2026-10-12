# 日志与运行状态

Relanox 输出 JSON 日志，并可提供 Prometheus 指标。日志帮助定位失败环节，指标帮助发现队列积压或渠道断线，消息状态则用于判断是否需要恢复。

## 开启日志和指标

日志和指标默认开启，指标中包含进程指标。需要覆盖默认行为时，再在 `relay` 中添加 `observability`，例如启用调试日志：

```json
{
  "observability": {
    "plugin": "standard",
    "config": {
      "level": "debug"
    }
  }
}
```

日志写到服务的标准输出。可以在运行 Relanox 的终端、服务管理器中查看；使用项目提供的 Compose 部署时，可以运行 `docker compose logs -f relanox`。需要时将 `level` 改为 `debug`、`warn` 或 `error`，然后重启服务。

使用默认管理设置时，可以检查以下本机地址：

```sh
curl http://127.0.0.1:8788/health/live
curl http://127.0.0.1:8788/health/ready
curl http://127.0.0.1:8788/metrics
```

`/health/live` 检查服务是否运行；`/health/ready` 检查数据库访问、服务是否接受工作以及处理任务是否正常。服务就绪时，渠道仍可能断线，因此也要查看连接指标。地址由 `server.managementHost` 和 `server.managementPort` 决定，请保持管理监听地址私有。容器部署时，从容器内部访问，或使用文档中的本机管理命令。

## 回复没到，先查什么？

按消息经过的环节查看以下日志事件。来信通知日志使用 `requestId`，发送入队和投递日志使用 `channelId`，管理状态中的 `deliveryId` 标识一次已保存的发送。发送独立于具体来信。

| 事件                 | 检查方向                                            |
| -------------------- | --------------------------------------------------- |
| `inbound.rejected`   | 发送者允许名单、会话绑定或不支持的输入。            |
| `dispatch.completed` | Agent 是否接受通知；查看 `outcome` 和 `errorCode`。 |
| `message.queued`     | 回复已保存，等待发送。                              |
| `retry.scheduled`    | 临时失败将会重试。                                  |
| `delivery.completed` | 查看发送结果。                                      |
| `delivery.unknown`   | 远端结果不确定，重试前先检查会话。                  |
| `connection.changed` | 平台连接状态有变化。                                |
| `storage.failed`     | 数据库访问需要检查。                                |

`authentication`、`authorization`、`rate_limit`、`timeout` 和 `storage` 等错误分类可以帮助缩小范围。日志不包含消息正文、已解析的凭据或平台原始错误对象。使用[运行维护](../operations.md)中的状态命令查看相关记录，仅在需要时开启消息正文，并妥善保护输出。

## 选择有用的告警

让 Prometheus 采集器访问私有的 `/metrics` 地址。可以先关注以下指标：

| 指标                                            | 含义                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `relanox_connection_status`                     | `1` 表示已连接，`0` 表示断线或连接降级。           |
| `relanox_pending`                               | 等待通知 Agent 的输入数量。                        |
| `relanox_outbound`                              | 尚未送达的回复数量，包括已停止的回复。             |
| `relanox_unknown`                               | 远端结果不确定、需要检查的操作数量。               |
| `relanox_oldest_pending_age_seconds`            | 最早等待通知的输入已等待多久。                     |
| `relanox_worker_last_success_timestamp_seconds` | 最近一次成功处理任务的时间；长时间不更新时可告警。 |
| `relanox_storage_stats_stale`                   | `1` 表示队列统计无法刷新。                         |
| `relanox_telemetry_dropped_total`               | 监控数据被丢弃，例如日志输出端处理太慢。           |

按部署所需的响应时间设置队列等待和处理任务新鲜度告警。`relanox_storage_stats_stale` 为 `1` 时，其他队列数值可能仍是上一次成功获取的快照。`relanox_delivery_total`、`relanox_retries_total` 等计数器会在进程重启后重置；耗时指标的单位为秒。

## 将追踪发送到采集器

追踪是可选功能。在标准监控插件的 `config` 中添加 `tracing`，填写采集器完整的 OTLP HTTP 追踪地址：

```json
{
  "tracing": {
    "endpoint": "http://127.0.0.1:4318/v1/traces",
    "sampleRatio": 0.1
  }
}
```

请替换为 Relanox 进程可以访问的地址。容器内的 `127.0.0.1` 指向容器自身。`sampleRatio: 0.1` 表示采样 10% 的追踪。追踪覆盖本地接收、通知和发送步骤，Agent 远端处理时间不会作为一个连续操作进行追踪。

采集器需要认证时，导出器可以使用 `OTEL_EXPORTER_OTLP_HEADERS` 或 `OTEL_EXPORTER_OTLP_TRACES_HEADERS`。这些环境变量应按凭据保护。采集器或日志输出失败不会停止消息处理，但监控数据可能丢失。

关闭监控时，将 `relay.observability` 设置为 `{ "plugin": "none", "config": {} }`。健康检查和就绪检查仍可使用。
