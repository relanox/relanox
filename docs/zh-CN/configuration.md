# 配置与 CLI

CLI 接收严格 JSON 对象：必需的 `relay` 和可选的 `server`、`media`、`mediaLimits`。公开 URL 发布与二进制限额见[媒体传输](media.md)，安装与首个账号示例见[快速开始](getting-started.md)。配置和 SecretRef 在进程生命周期内固定；修改 JSON 后重启进程。凭据在使用时从引用的环境变量解析，诊断和命令错误不输出其值。

## Relay 配置

| 字段            | 内容                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `accounts`      | 渠道账号数组：`id`、`channel`、`allowedSenders`、插件 `config`              |
| `endpoints`     | Agent endpoint 数组：`id`、`agent`、`dispatchMode`、插件 `config`           |
| `bindings`      | `accountId`、`chatId`、可选 `threadId`、`endpointId`、可选 `allowedSenders` |
| `storage`       | `plugin: "sqlite"` 或 `"postgres"` 与对应 `config`                          |
| `observability` | `plugin: "standard"` 或 `"none"` 与对应 `config`                            |

账号和 endpoint 的 ID 是 1–128 字符的本地名称，以字母或数字开头，其余允许字母、数字、下划线和连字符。平台 ID 是不透明字符串，即使看起来是数字也保持字符串。绑定必须引用存在的账号和 endpoint；`(accountId,chatId,threadId)` 不重复。匹配精确聊天与线程，没有线程回退或通配符。账号发送者白名单不能为空；绑定白名单存在时必须同时满足两层白名单。

endpoint 的 `agent` 只支持 `dot` 与 `grok`。`push` 由持久工作循环发送通知，`pull` 通过 MCP 直接领取，不自动 dispatch。完整配置见 [全部渠道示例](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json)，各插件字段见对应渠道指南和 [Agent](agents.md)。凭据字段使用 `{"env":"VARIABLE_NAME"}`；Google Chat 服务账号 JSON 是引用变量的值。

### 存储

SQLite `filename` 相对进程工作目录解析，不相对配置文件；启动前创建父目录。PostgreSQL 配置示例：

```json
{
  "plugin": "postgres",
  "config": {
    "connectionString": { "env": "RELANOX_DATABASE_URL" },
    "schema": "public"
  }
}
```

变量保存实际 DSN。`run` 自动创建缺失表和索引，不清空已有记录；存储不可用时拒绝启动。`doctor` 和 `status` 只检查存储，不初始化 schema，也不建立渠道连接。

## Server 配置

| 字段                                | 默认值               | 范围与用途                                            |
| ----------------------------------- | -------------------- | ----------------------------------------------------- |
| `host` / `port`                     | `127.0.0.1` / `8787` | 业务 HTTP listener；端口 0–65535                      |
| `managementHost` / `managementPort` | `127.0.0.1` / `8788` | 管理 listener；host 只允许字面量 `127.0.0.1` 或 `::1` |
| `workerIntervalMs`                  | `1000`               | 10–60000；一个批次完成后的等待，不重叠运行            |
| `workerStaleMs`                     | `60000`              | 100–600000；成功批次最大年龄，必须大于 interval       |
| `startupTimeoutMs`                  | `30000`              | 100–120000；原生连接初始化期限                        |
| `shutdownTimeoutMs`                 | `15000`              | 100–120000；排空、存储和观测关闭的总预算              |

容器使用 `host: "0.0.0.0"`，由可信反向代理终止 HTTPS，只转发业务路径。Agent host/origin 白名单应对应外部 URL。管理提供 GET `/health/live`、`/health/ready` 和启用时的 `/metrics`，不提供记录查询或恢复 HTTP 接口。业务 listener 不提供健康与指标路由。

就绪检查存储健康、接收状态、工作失败和批次新鲜度；渠道连接状态通过 `relanox_connection_status` 和结构化诊断单独表达，不代表真实账号验证。

## CLI 命令

所有命令要求 `--config <path>`，也可使用 `-c`。

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relay.json --limit 100
node apps/cli/dist/main.js status --config relay.json --endpoint-id grok-main --request-status claimed
node apps/cli/dist/main.js status --config relay.json --include-content
node apps/cli/dist/main.js requeue --config relay.json --kind request --id REQUEST_ID --expected-version 4
node apps/cli/dist/main.js requeue --config relay.json --kind delivery --id DELIVERY_ID --expected-version 7 --acknowledge-unknown
node apps/cli/dist/main.js cleanup --config relay.json --before 1790000000000 --limit 100
```

`validate` 检查配置及全部插件 schema，不解析凭据、不打开存储、不启动连接，也不证明平台权限。

`status` 返回持久统计和独立的请求/发送分页，`--limit` 为 1–1000，默认 100。`--after-id` 是不包含自身的 ID 游标；`--endpoint-id` 作用于两类记录。`--request-status` 为 pending/claimed/completed/failed，`--delivery-status` 为 pending/sent/rejected/unknown。默认省略文字、endpoint 配置、token、目标和回执；`--include-content` 只额外包含消息/结果文字。这是本地管理数据。

`doctor` 输出缺失的变量名、存储健康，可通过显式回环 HTTP origin 检查运行中服务的 readiness；拒绝重定向和远端管理地址。

`requeue` 要求 `status` 给出的当前版本，返回 updated/not_found/conflict/unauthorized。unknown 必须用 `--acknowledge-unknown` 承认重复外部效果的可能性。恢复只撤销本地 claim/lease；已发送分片保留，无法取消已运行的远端 Agent。详细恢复步骤见 [运维](operations.md)。

`cleanup` 使用 Unix 毫秒时间边界，limit 为 1–1000，默认 100；只清理符合保留条件的终态正文，保留去重和所有未完成/未送达工作。退出码 0 表示成功或帮助，1 表示脱敏后的命令失败，2 表示 doctor 不健康或恢复被拒绝。错误 JSON 不复制任意平台/驱动异常文字。

## 启停

`run` 管理原生连接和一个持久工作循环。部分连接已经初始化时可接收消息；全部初始化后异步运行首个批次，在其成功前 readiness 返回 503。积压处理不属于 startupTimeoutMs。

SIGINT/SIGTERM 停止接收、中止连接、关闭 listener 并在总预算内等待在途工作。某项清理失败仍会尝试释放存储和观测；部分启动失败也释放已获得资源。超时只返回脱敏失败，不保证远端取消或撤销不确定效果。重启后的持久 lease 和 unknown 状态仍是恢复依据。
