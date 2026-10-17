# 配置

配置采用严格 JSON。查找顺序为 `--config` / `-c`、`RELANOX_CONFIG`、当前目录已有的
`relanox.json`，最后是用户配置目录中的 `relanox/relanox.json`。数据库、凭据文件和
Muse 目录的相对路径，都以所选配置文件所在目录为基准。

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
包括很大的数字 ID。每条 binding 将准确的账号、聊天、线程组合路由到一个端点。
binding 的可选 `allowedSenders` 进一步收窄账号列表，发送者必须同时位于两个列表中。
空列表无效，省略则继承账号列表。

## 凭据

凭据引用格式为 `{ "env": "NAME", "file": "relative/path.secret" }`，两项至少一项。
非空环境变量优先，否则在使用时读取文件。文件中保存实际 token、密钥或 JSON 凭据，
不再通过另一个秘密文件间接保存目录路径。尾部换行会被去除；空文件和过大文件被拒绝。

CLI 在 `secrets/` 下创建独立文件，Unix 使用仅属主可访问权限，Windows 使用只允许当前
用户和 SYSTEM 的 DACL。刷新时保留旧凭据；配置修改产生 `*.backup-*` 备份。凭据和
备份不应提交到 Git。

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

原生选项文件只包含账号或端点的 `config` 对象，包括凭据引用。终端交互隐藏凭据输入。`--json` 用于脚本，必须提供所有不能自动生成的输入，
不会打开交互提示。

## Ent 存储与限制

SQLite 使用 `storage.driver = "sqlite"` 和 `storage.path`。PostgreSQL 使用
`storage.driver = "postgres"`、`storage.url` 凭据引用，以及可选 `storage.schema`。
两种数据库共用 Ent（`entgo.io/ent`）schema、生成查询构建器和事务 API；源码随附版本化
迁移。Go 程序拒绝旧 TypeScript 数据库和未知 schema 版本，不会静默重建或转换用户数据。

默认四个 worker、500 ms 轮询、60 秒通知租约、180 秒发送租约、八次尝试和 30 天保留期。
媒体默认单文件和单消息合计 100 MiB、十个附件；平台限制可能更低。仅在需要时调整
`queue`、`media` 和 HTTP 超时。未知结构字段和无效边界会在离线校验时被拒绝。

| HTTP 字段 | 默认值 | 作用范围 |
| --- | --- | --- |
| `readTimeoutSeconds` | 30 秒 | 应用和管理服务器的入站请求。 |
| `writeTimeoutSeconds` | 60 秒 | 应用和管理服务器的响应。 |
| `maxBodyBytes` | 4,194,304 字节（4 MiB） | 未单独声明上限的路由所用的请求体默认限制。 |

这些字段不设置所有 SDK 出站请求的统一期限。原生操作使用各自的超时，并受调用者
context 的取消控制。

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
    "metrics": true,
    "otlpEndpoint": "https://collector.example.com/v1/traces"
  }
}
```

将这些字段合并进主配置。腾讯云 ASR 对接收音频进行预处理，原文和媒体另行持久化。
普通日志排除正文与解析后的凭据，指标只位于回环管理监听；OTLP trace 可按需启用。
