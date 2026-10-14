# 配置参考

本章收录手动 JSON 配置与 CLI 约定。日常修改请使用[修改配置](../configuration.md)。

## 手动配置 Telegram 与 Grok 示例

完成安装后，手动配置可以复制 SQLite 示例。已经使用配置器下载文件时，保留原文件，不要用示例覆盖。

```powershell
Copy-Item examples/relanox.sqlite.json relanox.json
```

Linux/macOS 使用 `cp examples/relanox.sqlite.json relanox.json`，然后替换以下值：

| 位置                               | 你的值                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `relay.accounts[0].allowedSenders` | 字符串形式的 Telegram 用户 ID，例如 `["123456789"]`                         |
| `relay.bindings[0].chatId`         | 字符串形式的准确 Telegram 聊天 ID                                           |
| `publicUrl`                        | 公开 HTTPS 地址，例如 `https://relay.example.com`；使用非默认端口时带上端口 |
| `relay.storage.config.filename`    | 数据库路径；示例为启动目录中的 `relanox.sqlite`                             |

示例使用 `telegram-main` 和 `agent-1`。启动前提供以下环境变量：

| 变量                                    | 值                                     |
| --------------------------------------- | -------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                    | BotFather 提供的 token                 |
| `TELEGRAM_WEBHOOK_SECRET`               | 你生成的 Telegram webhook 随机密钥     |
| `RELANOX_AGENT_1_MCP_TOKEN`             | 独立生成的 MCP 原始 token              |
| `RELANOX_AGENT_1_ROUTINE_URL`           | 完整 Routine webhook URL               |
| `RELANOX_AGENT_1_ROUTINE_AUTHORIZATION` | 该 Routine 提供的完整 Authorization 值 |

分别为 Telegram webhook 和 MCP 连接生成独立随机密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

安装、提供变量和启动服务的步骤见[快速开始](../getting-started.md)。

## 生成配置的默认行为

默认监听地址和监控开关无需重复填写，生成器会省略这些默认值。不写 `server` 时，业务端口为 `127.0.0.1:8787`，管理端口为 `127.0.0.1:8788`；省略 `relay.observability` 即可启用标准日志和指标。只在部署需要时添加覆盖值；容器中需要设置 `server.host: "0.0.0.0"`。

dot 和 Grok 的 MCP 连接都需要公网可访问的 HTTPS 地址，包括主动连接平台的渠道。将 `publicUrl` 设置为这个地址；切换渠道时会保留已填写的服务地址。

配置器加载时会在浏览器中生成 32 字节十六进制 MCP token，可以编辑或重新生成。将生成的准确值复制到服务器环境变量中；JSON 保留环境变量引用。Relanox 不会自动加载 `.env` 文件。dot 使用这个值作为 OAuth 授权密码，Grok 将它作为 URL token。手动配置仍可使用[快速开始](../getting-started.md)中的随机 token 命令。

## 公开地址只配置一次

在顶层设置 `publicUrl`，与 `relay` 放在同一层：

```json
{
  "publicUrl": "https://relay.example.com"
}
```

Relanox 用它校验 MCP Host、生成附件下载链接，并推导 Google Chat 的认证 audience。公开媒体下载会自动启用。配置器也用这个地址展示渠道 webhook 和 Agent 连接 URL。

填写 HTTPS 来源地址，可带端口，不包含用户名密码、路径、查询参数或片段。本地开发允许字面地址 `http://127.0.0.1:8787` 和 `http://[::1]:8787`。实际监听地址仍由 `server` 控制；反向代理需保留公开 Host 头。

## 决定谁可以和哪个 Agent 聊天

三个列表描述你的连接：

- **账号**（`accounts`）：聊天平台上的机器人或服务账号，例如 Telegram bot。`config` 保存平台设置，`allowedSenders` 列出允许使用它的人。
- **Agent 连接**（`endpoints`）：一个已连接的 dot 或 Grok Agent。`config` 保存 MCP 凭据以及通知这个 Agent 的方式。
- **聊天绑定**（`bindings`）：把账号中的一个聊天连接到一个 Agent。这个聊天的消息发给所选 Agent，回信也发回这里。

例如，以下绑定将 Telegram 聊天 `123456789` 交给名为 `agent-1` 的 Grok：

```json
{
  "accountId": "telegram-main",
  "chatId": "123456789",
  "endpointId": "agent-1"
}
```

账号名和 Agent 连接名必须与列表中的条目一致。这些本地名字由你决定；用户、聊天和话题 ID 来自平台。所有 ID 都写成字符串，包括数字 ID。本地名字可以使用字母、数字、下划线和连字符，以字母或数字开头，长度最多 128 个字符。

每个聊天添加一条绑定。话题或线程需要写入准确的 `threadId`：

```json
{
  "accountId": "telegram-main",
  "chatId": "-1001234567890",
  "threadId": "42",
  "endpointId": "agent-1",
  "allowedSenders": ["123456789"]
}
```

绑定按聊天和话题精确匹配。省略 `threadId` 时仅匹配没有线程的消息。每个话题分别添加绑定。普通 Slack 频道或私聊消息省略 `threadId`；消息串内的回复使用该串真实根消息的时间戳作为 `threadId`，并为它配置精确绑定。账号的 `allowedSenders` 必填，至少包含一人；绑定中的可选 `allowedSenders` 进一步限制该聊天，发送者必须同时出现在两个名单中。ID 格式请按[对应平台的接入指南](../channels/index.md)填写。

[完整示例](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) 包含十五个渠道和两种 Agent。复制需要的条目，然后替换其中的 ID、凭据和绑定。

## 用环境变量保存凭据

凭据字段引用一个环境变量：

```json
{ "env": "TELEGRAM_BOT_TOKEN" }
```

把变量提供给运行 Relanox 的进程。终端启动读取当前终端的环境变量；Compose 使用配置的 `env_file`。源码启动时，需先将 `.env` 中的值载入进程环境。Google Chat 的服务账号变量保存完整的服务账号 JSON。

不同 Agent 连接使用独立 MCP token。Routine 的 Authorization 保留平台提供的完整值，它的 URL 也应作为密钥保护。[连接 Agent](../agents.md) 给出 dot 和 Grok 的具体设置。

轮换 token 时更新服务管理器的环境设置并重启。有排队回信时，保持原来的 bot/账号身份。更换 Grok Routine 时，使用新的环境变量名和 Agent 连接，已有消息仍然引用原来的设置。

## 可选的腾讯云语音识别 {#speech-to-text}

如需将发给 **dot** 的语音转成文字，把下面的片段合并到现有 `relanox.json`，保留原来的 `relay`、`publicUrl` 等配置。`speechToText` 位于顶层；配置器暂不生成此项：

```json
{
  "speechToText": {
    "provider": "tencent",
    "secretId": { "env": "TENCENT_ASR_SECRET_ID" },
    "secretKey": { "env": "TENCENT_ASR_SECRET_KEY" },
    "engine": "16k_zh"
  }
}
```

先开通腾讯云 ASR 服务，准备 **SecretId 和 SecretKey**，建议使用仅获准调用 `asr:SentenceRecognition` 的 CAM 子账号。真实值保存到部署目录的私有 `.env` 或服务环境变量中，不写入 JSON 或 Git：

```dotenv
TENCENT_ASR_SECRET_ID=你的SecretId
TENCENT_ASR_SECRET_KEY=你的SecretKey
```

Compose 通过 `env_file` 注入变量；直接从终端启动时，需要自行加载环境变量。先运行 `relanox validate --config relanox.json`，再运行 `relanox doctor --config relanox.json`，随后使用新环境重启或重建服务。`validate` 检查配置结构；`doctor` 列出缺失的变量名。已经配置转写但凭据不可用时，启动报 `speech_credentials_missing`，不会静默关闭。仅有环境变量不会启用；删除 JSON 配置项并重启即可关闭。

两项凭据引用均为必填，`engine` 默认 `16k_zh`；还支持 `16k_zh-PY`（中英粤）、`16k_en`、`16k_yue` 等模型。模型与音频要求见腾讯云[一句话识别文档](https://cloud.tencent.com/document/api/1093/35646)。

| 情况                                         | 转发给 dot 的内容                                                    |
| -------------------------------------------- | -------------------------------------------------------------------- |
| 未配置 `speechToText`                        | 原文字和原音频保持不变，不请求 ASR。                                 |
| 识别成功                                     | 原文字后追加带标记的转写文字，保留全部原始附件。                     |
| 超时、服务报错、结果无效或为空、输入不受支持 | 原文字和原音频，另在 `transcriptions` 中附上不含敏感内容的失败代码。 |

仅转写类型为 `audio` 且目标为 dot 的附件。Grok、视频音轨和普通文件仍走原有流程。音频通过 HTTPS 请求体发送给腾讯云，无需公开音频下载地址；不做本地推理、转码或长音频切分。支持 WAV、PCM、Ogg Opus、Speex、SILK、MP3、M4A、AAC 和 AMR；Ogg Vorbis、WebM 回退原音频。QQ SILK 即使被标成 AMR，也会根据文件头识别。PCM 本身必须符合所选模型的要求。

接口限制为 60 秒以内。Relanox 保守限制 **Base64 数据不超过 3,000,000 字节**，即原始数据不超过 2,250,000 字节。已知时长超过 60 秒时跳过，否则由腾讯云校验实际音频。单次 HTTP 请求限时八秒，整条消息的转写阶段限时十秒。多段音频分别记录结果并保持附件顺序。这些限制独立于一般附件大小限制。

原始消息与音频先入库、再确认接收，之后由后台 worker 转写。转写未完成时，不会出现在 Agent 的消息读取结果中，也不能提交关联回复。结果在 SQLite 或 PostgreSQL 中单独保存，不改写原始快照。通知和 `relanox_read_messages` 使用相同内容，`transcriptions` 每项包含 `mediaId`、`status` 以及成功时的 `text` 或失败时的 `errorCode`。常规消息清理也会清除转写文本。本功能无需变更数据库表结构。

每个已接收的音频附件只尝试识别一次。通知重试、手动重新通知和重启均复用已保存结果。尚未开始的任务在重启后继续；若识别途中进程中断，租约过期后记录 `interrupted` 并回退原音频，避免重复发起可能已计费的请求。删除配置后，仍在等待的任务以 `disabled` 回退；已经完成的结果仍可使用。用户重新发送一条新的平台消息才会开始新的识别尝试。

识别可能产生费用，以腾讯云[现行计费说明](https://cloud.tencent.com/document/product/1093/35686)为准。失败代码记录在 `transcription.failed` 日志，另提供 `relanox_transcription_total` 计数和 `relanox_transcription_duration_seconds` 耗时；日志不含音频、转写文本或凭据。原样转发不代表 dot 一定能听懂音频。本地测试验证协议与回退行为，不代表真实账号的识别效果。

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

在 `RELANOX_DATABASE_URL` 中提供连接字符串，并让数据库用户拥有在指定 schema 创建表和索引的权限。`run` 创建缺少的表并保留已有消息。升级前按[部署与备份](../operations.md)备份。

## 设置端口和常用选项

顶层可选的 `server` 对象控制 HTTP 监听以及启动、关闭的等待期限：

| 选项                | 默认值      | 何时修改                                             |
| ------------------- | ----------- | ---------------------------------------------------- |
| `host`              | `127.0.0.1` | 容器中设为 `0.0.0.0`，使映射的业务端口可达           |
| `port`              | `8787`      | 更改反向代理连接的业务端口                           |
| `managementHost`    | `127.0.0.1` | 使用 IPv6 回环时设为 `::1`                           |
| `managementPort`    | `8788`      | 更改本地健康检查与指标端口                           |
| `startupTimeoutMs`  | `30000`     | 为渠道启动和 CLI 管理操作留出更多时间                |
| `shutdownTimeoutMs` | `15000`     | 为正常停机留出更多时间，同时增加服务管理器的停止超时 |

端口范围为 0–65535，部署时使用固定的非零端口。管理地址使用字面回环地址。通过 HTTPS 代理业务端口 8787，管理端口保留在本地。如果 MCP 客户端发送 Origin 头，将它的完整来源加入 `mcp.allowedOrigins`。它表示调用方来源，与服务公开地址不同；不发送该头的服务端客户端使用默认空列表即可。

日志和指标默认开启。需要调整时再添加 `relay.observability`，例如只输出警告和错误日志：

```json
{
  "observability": {
    "plugin": "standard",
    "config": { "level": "warn" }
  }
}
```

管理端口提供 `/health/live`、`/health/ready` 和开启后的 `/metrics`。[日志与运行状态](observability.md)介绍指标名称。可选的 `media.urlLifetimeMs` 控制下载链接有效期，`mediaLimits` 控制附件大小；下载地址使用 `publicUrl`，见[收发图片和文件](../media.md)。

## 自动查询账号身份

Relanox 启动时使用配置的凭据向 Slack、Discord、飞书/Lark、LINE、Matrix 和 Mattermost 查询所连接的账号。查询失败会导致启动失败，此时应检查凭据和平台连接。`validate` 仍然离线执行，不能验证凭据对应的账号身份。

尚有排队回复时，应保持凭据属于原账号。应用 ID、允许发送者和会话绑定仍表达你的接入选择，需要填写。

### 固定平台地址

原生托管平台自动使用对应的协议地址。

QQ 默认使用正式环境，需要沙箱时将 `environment` 设为 `"sandbox"`。WhatsApp 的 Graph API 版本由 Relanox 管理，目前为 `v25.0`。Telegram 本地 Bot API 地址，以及 Matrix、Mattermost 和 Signal 自托管地址仍可配置。Teams 保留用于单租户应用认证地址的 `tokenUrl`，以及服务、媒体和上传的可信来源。

## 使用 CLI

从仓库根目录运行构建后的 CLI。每条命令带 `--config <文件>`，也可简写为 `-c`：

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relanox.json --limit 100
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
node apps/cli/dist/main.js status --config relanox.json --endpoint-id agent-1 --dispatch-status unknown
node apps/cli/dist/main.js status --config relanox.json --delivery-status pending
node apps/cli/dist/main.js status --config relanox.json --include-content
```

通知状态可筛选 `due`、`accepted`、`rejected`、`unknown`；回信状态可筛选 `pending`、`sent`、`rejected`、`unknown`。默认每页 100 条，`--limit` 范围 1–1000。用 `--after-id <id>` 从某条记录之后继续查询。`--include-content` 会加入消息正文，请按私人聊天数据保护输出。

[部署与备份](../operations.md#查找并恢复卡住的消息)给出恢复和清理命令。CLI 输出 JSON。退出码 0 表示成功，1 表示命令失败，2 表示诊断不健康或恢复被拒绝。用 Ctrl+C 或服务管理器的正常停止命令关闭服务。
