# 运维

Relanox 从 SQLite 或 PostgreSQL 恢复已接收的任务。数据库保存入站消息、预处理结果、
出站计划、媒体与组件状态。

## 健康与观测

管理监听必须绑定回环地址，默认端点如下：

| 地址 | 含义 |
| --- | --- |
| `http://127.0.0.1:8788/health/live` | HTTP 进程响应正常。 |
| `http://127.0.0.1:8788/health/ready` | 接收已启用、存储健康且 worker 未发生故障。 |
| `http://127.0.0.1:8788/metrics` | 启用时提供 Prometheus 指标。 |

这些路由与公网回调、MCP 监听分离。普通日志限制字段的取值和格式，排除正文、凭据与请求头。
可选的 OTLP 链路追踪覆盖原生接收、队列与 Agent 工具调用。HTTP 健康检查通过时，
原生连接仍可能不可用。

指标使用取值受控的 `plugin` 标签，通知、发送、重试和预处理计数随真实执行更新。
队列指标还包括最早待处理任务的等待时间、worker 最近成功时间，以及存储统计是否陈旧。
统计刷新失败时保留上次值，并标记为陈旧。

```sh
relanox doctor --config relanox.json --management-url http://127.0.0.1:8788 --json
relanox status --config relanox.json --limit 50 --json
```

运维命令 `validate`、`doctor`、`status`、`requeue`、`cleanup`、`discover` 和
`wechat-login` 默认输出 JSON；使用 `--json=false` 输出文本。指定 `--json` 也会禁止交互提示。
Doctor 列出缺失的环境变量或凭据文件引用，检查已有数据库，不连接通道。

Status 包含请求的 `reply`、发送记录的 `reply` 和 `dueAt`，请求与发送记录的时间使用
Unix 毫秒。支持 `--endpoint-id`、
`--dispatch-status`、`--delivery-status` 与 `--after-id`。两个列表的每一页都按记录 ID 升序排列。
遍历某个列表时，将该页最后一个 ID 传给 `--after-id`，并读取下一次响应中的同一列表；
这个游标也会独立过滤另一个列表。

只有 `--include-content` 才输出正文，私有原生回复地址和接收时保存的凭据引用始终不输出。
管理读取不会创建缺失数据库或初始化空 schema。

## 结果不明与重放

Relanox 区分拒绝、可重试失败和远端执行结果不明。进程在请求可能已到达外部服务后退出，
盲目重放可能重复执行。具备持久幂等性的原生操作可以自动恢复，短期 nonce 不足以提供
这种保证。

```sh
relanox requeue --kind request --id REQUEST_ID --expected-version VERSION --json
relanox requeue --kind delivery --id DELIVERY_ID --expected-version VERSION \
  --acknowledge-unknown --json
```

使用 Status 打印的 ID 和当前版本；过期版本会被拒绝。请求和出站记录处于结果不明状态时，
都需要 `--acknowledge-unknown`，明确接受操作可能重复的影响。入站用 `request`，
出站用 `delivery`。入站也接受 `prepare`，但会保留已有预处理结果，不会强制重新执行
已完成的语音识别。
等待平台文件授权或被动回调的待处理任务不消耗发送重试次数。
同一会话按持久化入队顺序发送，同一毫秒接收的消息也不会乱序。平台要求的重试等待时间
会被保留；平台未指定等待时间时，自动指数退避最多五分钟。

## 保留与备份

服务运行时，每分钟按 `queue.retentionDays`（默认 30 天）执行一次保留清理，每个清理
类别的批次上限为 100。管理命令可以指定截止时间和批次大小：

```sh
relanox cleanup --before 2026-10-01T00:00:00Z --limit 1000 --json
```

清理按批次脱敏已完成记录，并移除无需保留的媒体，同时保留去重记录、
最终回复标识、待处理和结果不明的任务。limit 分别限制每个存储清理类别的批次大小，
不代表本次修改的总行数。
时间也接受 Unix 毫秒。

一起备份配置、引用的凭据、Muse 配对目录和数据库。SQLite 停止服务后复制数据库文件，
或使用数据库备份机制；PostgreSQL 使用一致性备份。修改 schema 前保留可恢复的备份。

收到 SIGINT / SIGTERM 后，服务停止接收新消息，取消原生连接和 worker，等待 HTTP 请求
完成，并在后台任务退出后关闭存储。关闭期限由 `http.shutdownTimeoutSeconds` 设置，
默认 15 秒。已经传输的请求仍可能产生结果不明状态。使用服务管理器在进程失败后重启。
