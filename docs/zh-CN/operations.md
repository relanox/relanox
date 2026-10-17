# 运维

SQLite 或 PostgreSQL 保存已接收输入、预处理结果、出站计划、媒体与组件状态。
恢复已接收工作不依赖本地聊天记录文件或内存队列。

## 健康与观测

管理监听必须绑定回环地址，默认端点如下：

| 地址 | 含义 |
| --- | --- |
| `http://127.0.0.1:8788/health/live` | HTTP 进程响应正常。 |
| `http://127.0.0.1:8788/health/ready` | 接收已启用、存储健康且 worker 未发生故障。 |
| `http://127.0.0.1:8788/metrics` | 启用时提供 Prometheus 指标。 |

这些路由与公网回调、MCP 监听分离。普通日志使用有界字段，排除正文、凭据与请求头。
可选 OTLP trace 贯通原生接收、队列与 Agent 工具调用。原生连接状态与 HTTP 健康不同。

```sh
relanox doctor --config relanox.json --management-url http://127.0.0.1:8788 --json
relanox status --config relanox.json --limit 50 --json
```

Doctor 检查配置、凭据和已有数据库，不连接通道。Status 支持 `--endpoint-id`、
`--dispatch-status`、`--delivery-status` 与 `--after-id`。只有 `--include-content`
才输出正文，私有原生回复地址和捕获的凭据始终不输出。管理读取不会创建缺失数据库或
初始化空 schema。

## 结果不明与重放

拒绝、可重试失败和远端效果不明是不同结果。进程在请求可能已到达外部服务后退出，
盲目重放可能重复执行。具备持久幂等性的原生操作可以自动恢复，短期 nonce 不足以提供
这种保证。

```sh
relanox requeue --kind request --id REQUEST_ID --expected-version VERSION --json
relanox requeue --kind delivery --id DELIVERY_ID --expected-version VERSION \
  --acknowledge-unknown --json
```

使用 Status 打印的 ID 和当前版本。第二条命令显式接受结果不明操作可能重复的影响，
过期版本会被拒绝。`prepare` 选择预处理，普通请求用 `request`，出站用 `delivery`。
等待原生 consent 或被动回调的 Pending 不消耗发送重试预算。

## 保留与备份

```sh
relanox cleanup --before 2026-10-01T00:00:00Z --limit 1000 --json
```

清理在有界批次中脱敏已完成记录，并移除无需保留的无引用媒体，同时保留持久去重、
最终回复身份、待处理和结果不明工作。limit 分别作用于存储清理类别，不是总行数估算。
时间也接受 Unix 毫秒。

一起备份配置、引用的凭据、Muse 配对目录和数据库。SQLite 停止服务后复制数据库文件，
或使用数据库备份机制；PostgreSQL 使用一致性备份。迁移前保留原库，Go 程序不会自行
将旧 TypeScript 数据库转换为 Ent schema。

SIGINT / SIGTERM 停止新接收，取消原生连接和 worker，排空 HTTP，再在工作退出后关闭
存储。超过关闭期限的已发送请求仍可能产生结果不明状态。使用服务管理器重启失败的
长期进程。
