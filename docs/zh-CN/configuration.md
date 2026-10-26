# 配置

配置采用严格 JSON。查找顺序为 `--config` / `-c`、`RELANOX_CONFIG`、当前目录已有的
`relanox.json`，最后是用户配置目录中的 `relanox/relanox.json`。数据库、凭据文件和
Muse 目录的相对路径，都以所选配置文件所在目录为基准。

[连接配置器](connect.md)可以生成这一 JSON 格式，凭据使用环境变量或文件引用。

## 账号、端点和会话绑定

```json
{
  "storage": { "driver": "sqlite", "path": "state/relanox.db" },
  "http": {
    "listen": "127.0.0.1:8787",
    "managementListen": "127.0.0.1:8788",
    "publicUrl": "https://relay.example.com"
  },
  "accounts": [
    {
      "id": "telegram",
      "channel": "telegram",
      "allowedSenders": ["123456789"],
      "config": {
        "botToken": { "env": "TELEGRAM_TOKEN" },
        "webhookSecret": { "file": "secrets/telegram-webhook.secret" }
      }
    }
  ],
  "endpoints": [
    {
      "id": "grok",
      "agent": "grok",
      "config": {
        "mcp": { "auth": "bearer", "token": { "file": "secrets/grok-mcp.secret" } },
        "routineUrl": { "env": "GROK_ROUTINE_URL" },
        "routineAuthorization": { "env": "GROK_ROUTINE_AUTHORIZATION" }
      }
    }
  ],
  "bindings": [
    { "accountId": "telegram", "chatId": "123456789", "endpointId": "grok" }
  ]
}
```

账号与端点 ID 是本地名称。发送者、聊天和线程 ID 保留平台原始格式，并使用字符串，
包括很大的数字 ID。每条会话绑定将准确的账号、聊天、线程组合路由到一个端点。
绑定中的可选 `allowedSenders` 进一步限制账号列表，发送者必须同时位于两个列表中。
空列表无效，省略则继承账号列表。

## 凭据

凭据引用格式为 `{ "env": "NAME", "file": "relative/path.secret" }`，两项至少一项。
非空环境变量优先，否则在使用时读取文件。文件中保存实际 token、密钥或 JSON 凭据，
不能填写另一个凭据文件的路径。使用时读取凭据，轮换后的新值也能用于已排队任务。
尾部换行会被去除；空文件和过大文件被拒绝。

CLI 在 `secrets/` 下创建独立文件，Unix 使用仅属主可访问权限，Windows 使用只允许当前
用户和 SYSTEM 的 DACL。刷新时保留旧凭据；配置修改产生 `*.backup-*` 备份。凭据和
备份不应提交到 Git。

配置修改通过 `<config>.lock` 文件取得独占锁。修改失败且锁文件无法删除时，错误会包含
`config_lock_release_failed`。`config_saved_but_lock_release_failed` 表示新配置及其托管
凭据已提交，但锁文件仍然存在。确认没有配置命令正在运行后，删除残留锁文件再继续修改。

## 脚本配置

```sh
relanox init -c relanox.json --public-url https://relay.example.com
relanox account add -c relanox.json --id telegram --channel telegram \
  --allowed-sender 123456789 --native-config telegram-options.json --json
relanox agent add -c relanox.json --id grok --agent grok \
  --native-config grok-options.json --json
relanox bind -c relanox.json --account telegram --chat 123456789 --endpoint grok --json
relanox validate -c relanox.json --json
```

原生选项文件只包含账号或端点的 `config` 对象，包括凭据引用。终端交互隐藏凭据输入。
脚本使用 `--json`，并提供所有不能自动生成的输入；此模式不会打开交互提示。

## Ent 存储与限制

SQLite 使用 `storage.driver = "sqlite"` 和 `storage.path`。PostgreSQL 使用
`storage.driver = "postgres"`、`storage.url` 凭据引用，以及可选 `storage.schema`。
两种数据库共用 Ent（`entgo.io/ent`）schema、生成的查询构建器和事务 API；源码随附版本化
迁移。程序拒绝不支持的 schema 格式，保留现有数据库不变。

默认四个 worker、500 ms 轮询、60 秒通知租约、630 秒发送租约、八次尝试和 30 天保留期。
Agent 通知和预处理的调用期限为 10 秒；原生发送最多 600 秒，同时受租约和调用者 context 限制。
默认每个媒体文件不超过 100 MiB，每条消息的媒体总量不超过 100 MiB，附件不超过十个；
平台限制可能更低。仅在需要时调整
`queue`、`media` 和 HTTP 超时。未知结构字段和无效边界会在离线校验时被拒绝。

| HTTP 字段 | 默认值 | 作用范围 |
| --- | --- | --- |
| `startupTimeoutSeconds` | 30 秒 | 存储初始化和组件启动，接受 1–120 秒。 |
| `shutdownTimeoutSeconds` | 15 秒 | 等待 HTTP 请求完成并关闭原生组件，接受 1–120 秒。 |
| `readTimeoutSeconds` | 30 秒 | 应用和管理服务器的入站请求。 |
| `writeTimeoutSeconds` | 60 秒 | 应用和管理服务器的响应。 |
| `maxBodyBytes` | 4,194,304 字节（4 MiB） | 未单独声明上限的路由所用的请求体默认限制。 |

HTTP 读写超时不设置所有 SDK 出站请求的统一期限。原生操作使用各自的超时，并受调用者
context 的取消控制。入站 `context` 与私有回复目标数据的 JSON 合计上限为 64 KiB。

## 语音与观测

```json
{
  "speech": {
    "enabled": true,
    "secretId": { "env": "TENCENT_SECRET_ID" },
    "secretKey": { "env": "TENCENT_SECRET_KEY" },
    "region": "ap-guangzhou",
    "engineModelType": "16k_zh"
  },
  "observability": {
    "level": "info",
    "logs": true,
    "metrics": true,
    "otlpEndpoint": "https://collector.example.com/v1/traces"
  }
}
```

将这些字段合并进主配置。腾讯云 ASR 对接收音频进行预处理，原文和媒体另行持久化。
音频附件并发处理，每个文件的识别调用分别有八秒期限，同时受预处理调用和父 context 限制。
日志和指标默认启用，可分别用 `logs: false` 与 `metrics: false` 关闭。普通日志输出到 stdout，
排除正文与解析后的凭据；指标只通过绑定回环地址的管理接口提供。OTLP 链路追踪可按需启用，
新建根 trace 全部采样，存在父 trace 时遵循其采样决定。
