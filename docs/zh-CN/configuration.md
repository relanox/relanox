# 修改配置

Relanox 从一个 JSON 文件读取配置。先复制 [SQLite 示例](https://github.com/relanox/relanox/blob/master/examples/relanox.sqlite.json)，再换成自己的账号和 Agent 设置。修改后重启服务，让新配置生效。

首次配置可以使用[连接配置器](connect.md)：左侧选择渠道和 Agent，右侧实时更新配置。展开“连接信息”，填写域名、聊天 ID 和允许使用的用户，再复制或下载 JSON；接入教程会按你的选择生成。每个渠道先配置一个账号和一个聊天，更多聊天可按下文添加绑定。凭据保留为环境变量引用。

默认监听地址和监控开关无需重复填写，生成器会省略这些默认值。不写 `server` 时，业务端口为 `127.0.0.1:8787`，管理端口为 `127.0.0.1:8788`；标准可观测性插件使用 `config: {}` 即可启用日志和指标。只在部署需要时添加覆盖值；容器中需要设置 `server.host: "0.0.0.0"`。

## 决定谁可以和哪个 Agent 聊天

三个列表描述你的连接：

- **账号**（`accounts`）：聊天平台上的机器人或服务账号，例如 Telegram bot。`config` 保存平台设置，`allowedSenders` 列出允许使用它的人。
- **Agent 连接**（`endpoints`）：一个已连接的 dot 或 Grok Agent。`config` 保存 MCP 凭据以及通知这个 Agent 的方式。
- **聊天绑定**（`bindings`）：把账号中的一个聊天连接到一个 Agent。这个聊天的消息发给所选 Agent，回信也发回这里。

例如，以下绑定将 Telegram 聊天 `123456789` 交给名为 `grok-main` 的 Grok：

```json
{
  "accountId": "telegram-main",
  "chatId": "123456789",
  "endpointId": "grok-main"
}
```

账号名和 Agent 连接名必须与列表中的条目一致。这些本地名字由你决定；用户、聊天和话题 ID 来自平台。所有 ID 都写成字符串，包括数字 ID。本地名字可以使用字母、数字、下划线和连字符，以字母或数字开头，长度最多 128 个字符。

每个聊天添加一条绑定。话题或线程需要写入准确的 `threadId`：

```json
{
  "accountId": "telegram-main",
  "chatId": "-1001234567890",
  "threadId": "42",
  "endpointId": "grok-main",
  "allowedSenders": ["123456789"]
}
```

绑定按聊天和话题精确匹配。省略 `threadId` 时仅匹配没有线程的消息。每个话题分别添加绑定。Slack 将根消息时间戳作为 `threadId`，因此每个根线程也需要独立绑定。账号的 `allowedSenders` 必填，至少包含一人；绑定中的可选 `allowedSenders` 进一步限制该聊天，发送者必须同时出现在两个名单中。ID 格式请按[对应平台的接入指南](channels/index.md)填写。

[完整示例](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) 包含十五个渠道和两种 Agent。复制需要的条目，然后替换其中的 ID、凭据和绑定。

## 用环境变量保存凭据

凭据字段引用一个环境变量：

```json
{ "env": "TELEGRAM_BOT_TOKEN" }
```

把变量提供给运行 Relanox 的进程。终端启动读取当前终端的环境变量；Compose 使用配置的 `env_file`。源码启动时，需先将 `.env` 中的值载入进程环境。Google Chat 的服务账号变量保存完整的服务账号 JSON。

不同 Agent 连接使用独立 MCP token。Routine 的 Authorization 保留平台提供的完整值，它的 URL 也应作为密钥保护。[连接 Agent](agents.md) 给出 dot 和 Grok 的具体设置。

轮换 token 时更新服务管理器的环境设置并重启。有排队回信时，保持原来的 bot/账号身份。更换 Grok Routine 时，使用新的环境变量名和 Agent 连接，已有消息仍然引用原来的设置。

## 选择消息保存位置

单个安装可以使用 SQLite：

```json
{
  "storage": {
    "plugin": "sqlite",
    "config": { "filename": "data/relanox.sqlite" }
  }
}
```

将这个对象放在 `relay` 内，启动前创建 `data` 目录。相对路径以进程的工作目录为准。也可以使用绝对路径；Docker 中使用 `/data/relanox.sqlite`。

使用 PostgreSQL 时替换存储对象：

```json
{
  "storage": {
    "plugin": "postgres",
    "config": {
      "connectionString": { "env": "RELANOX_DATABASE_URL" },
      "schema": "public"
    }
  }
}
```

在 `RELANOX_DATABASE_URL` 中提供连接字符串，并让数据库用户拥有在指定 schema 创建表和索引的权限。`run` 创建缺少的表并保留已有消息。升级前按[部署与备份](operations.md)备份。

## 设置端口和常用选项

顶层可选的 `server` 对象控制 HTTP 监听和处理间隔：

| 选项                | 默认值      | 何时修改                                                    |
| ------------------- | ----------- | ----------------------------------------------------------- |
| `host`              | `127.0.0.1` | 容器中设为 `0.0.0.0`，使映射的业务端口可达                  |
| `port`              | `8787`      | 更改反向代理连接的业务端口                                  |
| `managementHost`    | `127.0.0.1` | 使用 IPv6 回环时设为 `::1`                                  |
| `managementPort`    | `8788`      | 更改本地健康检查与指标端口                                  |
| `workerIntervalMs`  | `1000`      | 更改两批消息处理之间的等待时间                              |
| `workerStaleMs`     | `60000`     | 更改就绪检查允许多久没有成功批次；需大于 `workerIntervalMs` |
| `startupTimeoutMs`  | `30000`     | 为平台连接初始化留出更多时间                                |
| `shutdownTimeoutMs` | `15000`     | 为正常停机留出更多时间，同时增加服务管理器的停止超时        |

端口范围为 0–65535，部署时使用固定的非零端口。管理地址使用字面回环地址。通过 HTTPS 代理业务端口 8787，管理端口保留在本地。Agent 的 `mcp.allowedHosts` 填公开主机名，包括非默认端口。如果 MCP 客户端发送 Origin 头，将它的完整来源加入 `mcp.allowedOrigins`；不发送该头的服务端客户端适合空列表。

用 `relay.observability` 开启日志和指标：

```json
{
  "observability": {
    "plugin": "standard",
    "config": { "logs": true, "metrics": true, "processMetrics": true }
  }
}
```

管理端口提供 `/health/live`、`/health/ready` 和开启后的 `/metrics`。[日志与运行状态](reference/observability.md)介绍指标名称。附件大小限制和公开下载地址使用顶层 `media`、`mediaLimits`，见[收发图片和文件](media.md)。

## 更新旧配置

连接时序和固定的平台身份现在由程序内部管理。如果旧文件包含下列字段，请删除后再运行 `validate`；校验器会拒绝未知字段。原来的默认行为仍然保留。

| 配置位置                                                        | 删除字段                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| Agent 的 `mcp`                                                  | `maxBodyBytes`、`timeoutMs`                                   |
| dot                                                             | `callback.timeoutMs`、`subscriptionTtlMs`、`rotationWindowMs` |
| Grok                                                            | `timeoutMs`、`maxBodyBytes`                                   |
| Telegram、Slack、Discord、飞书、IRC、Matrix、Mattermost、Signal | `timeoutMs`                                                   |
| Slack、Discord                                                  | `reconnectDelayMs`                                            |
| IRC、Matrix、Mattermost、Signal                                 | `reconnectMs`                                                 |
| Matrix                                                          | `syncTimeoutMs`                                               |
| 钉钉、企业微信、QQ                                              | `maxReconnectAttempts`                                        |
| 企业微信                                                        | `heartbeatMs`                                                 |
| QQ                                                              | `transport`                                                   |
| Discord                                                         | `intents`                                                     |
| Google Chat                                                     | `callerEmail`、`issuer`                                       |
| Microsoft Teams                                                 | `issuer`                                                      |

凭据、发送者白名单、可信来源和部署地址仍可配置。配置器自动使用平台原生地址，自建服务仍需填写地址。服务、数据库、监控和媒体容量等高级选项按部署需要设置即可。

## 使用 CLI

从仓库根目录运行构建后的 CLI。每条命令带 `--config <文件>`，也可简写为 `-c`：

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relay.json --limit 100
```

| 命令       | 用途                                                         |
| ---------- | ------------------------------------------------------------ |
| `validate` | 启动前检查 JSON、账号设置和绑定                              |
| `run`      | 初始化存储，持续运行连接和消息处理                           |
| `doctor`   | 检查存储和环境变量；加 `--management-url` 检查正在运行的服务 |
| `status`   | 查看已保存的来信和回信                                       |
| `requeue`  | 查明原因后重试保留的通知或回信                               |
| `cleanup`  | 按保留策略清理符合条件的旧消息内容                           |

`validate` 检查配置结构，`doctor` 查找缺失变量，再发送消息验证平台连接。新安装应先运行一次 `run`，让存储检查正常。`doctor` 的管理 URL 使用本地 HTTP 来源，例如上述地址。

缩小状态查询范围：

```sh
node apps/cli/dist/main.js status --config relay.json --endpoint-id grok-main --dispatch-status unknown
node apps/cli/dist/main.js status --config relay.json --delivery-status pending
node apps/cli/dist/main.js status --config relay.json --include-content
```

通知状态可筛选 `due`、`accepted`、`rejected`、`unknown`；回信状态可筛选 `pending`、`sent`、`rejected`、`unknown`。默认每页 100 条，`--limit` 范围 1–1000。用 `--after-id <id>` 从某条记录之后继续查询。`--include-content` 会加入消息正文，请按私人聊天数据保护输出。

[部署与备份](operations.md#查找并恢复卡住的消息)给出恢复和清理命令。CLI 输出 JSON。退出码 0 表示成功，1 表示命令失败，2 表示诊断不健康或恢复被拒绝。用 Ctrl+C 或服务管理器的正常停止命令关闭服务。
