# 快速开始

将 Telegram bot 连接到 Grok Bot，发送消息，并在同一个聊天收到答案。使用 dot 时，安装完成后按[连接 Agent](agents.md)继续。

## 1. 准备账号

准备以下内容：

- 从 BotFather 获取的 Telegram bot token、你的用户 ID 和目标聊天 ID。私人聊天的 chat ID 通常就是用户 ID。群组和话题设置见 [Telegram](channels/telegram.md)。
- 一个支持 webhook 触发 Routine 的 Grok Bot、完整 webhook URL 和 Authorization 值，以及 MCP 连接。
- 可以持续运行 Relanox 的机器，以及公开 HTTPS 地址，例如 `https://relay.example.com`。[部署与备份](operations.md)提供反向代理示例。
- 源码安装需要 Git、Node.js 26.11.1 和 pnpm 12.11.2。[部署与备份](operations.md)也提供 Docker 安装方式。

分别为 Telegram webhook 和 Grok MCP 连接生成独立随机密钥，并保存在密钥管理器中：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 2. 安装并复制示例

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

PowerShell 中复制示例：

```powershell
Copy-Item examples/relanox.sqlite.json relay.json
```

Linux/macOS 使用 `cp examples/relanox.sqlite.json relay.json`。编辑 `relay.json`：

| 位置                               | 你的值                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `relay.accounts[0].allowedSenders` | 字符串形式的 Telegram 用户 ID，例如 `["123456789"]`                         |
| `relay.bindings[0].chatId`         | 字符串形式的准确 Telegram 聊天 ID                                           |
| `publicUrl`                        | 公开 HTTPS 地址，例如 `https://relay.example.com`；使用非默认端口时带上端口 |
| `relay.storage.config.filename`    | 数据库路径；示例为启动目录中的 `relanox.sqlite`                             |

保留本地名字 `telegram-main` 和 `grok-main`，下面的 URL 会使用它们。同一主机上的反向代理使用 `server.host: "127.0.0.1"`；容器内使用 `0.0.0.0`。

## 3. 提供环境变量

| 变量                         | 值                                     |
| ---------------------------- | -------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | BotFather 提供的 token                 |
| `TELEGRAM_WEBHOOK_SECRET`    | 你生成的 Telegram webhook 随机密钥     |
| `GROK_MCP_TOKEN`             | 独立生成的 MCP 原始 token              |
| `GROK_ROUTINE_URL`           | 完整 Routine webhook URL               |
| `GROK_ROUTINE_AUTHORIZATION` | 该 Routine 提供的完整 Authorization 值 |

在 PowerShell 中通过提示输入，避免把密钥直接写入命令历史：

```powershell
foreach ($name in @('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GROK_MCP_TOKEN', 'GROK_ROUTINE_URL', 'GROK_ROUTINE_AUTHORIZATION')) {
  $value = Read-Host $name -AsSecureString
  [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $value).Password, 'Process')
}
```

服务部署时通过受保护的服务环境设置提供变量。Docker 使用[部署与备份](operations.md)中的 `.env` 文件。源码启动读取当前终端环境，启动前先载入变量。

## 4. 启动 Relanox

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
```

校验成功会输出 `ok: true` 和账号、Agent 数量。启动会创建数据库表，并输出带监听地址的 `started` 事件。保持终端运行。

另开终端，提供相同环境变量并运行：

```sh
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
```

等待 `ok` 为 `true`。新数据库应先启动服务再检查：启动会初始化存储，首次消息处理批次成功后就绪状态转为健康。

## 5. 接通 Telegram 和 Grok

设置 HTTPS 反向代理，将请求转发到 `http://127.0.0.1:8787`，保留公开 Host 头。在持有密钥的 PowerShell 终端中替换公开地址并注册 Telegram webhook：

```powershell
$publicUrl = 'https://relay.example.com'
$body = @{
  url = "$publicUrl/channels/telegram-main/webhook"
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType 'application/json' -Body $body
```

Telegram 应返回 `ok: true`。共享截图和输出前去掉 token。

为 Grok Bot 添加 MCP 连接：

- URL：`https://relay.example.com/agents/grok/mcp/grok-main`。
- 认证：使用 `GROK_MCP_TOKEN` 的 Bearer 认证。token 输入框填原始 token；Authorization 头输入框填 `Bearer <token>`。

设置 Routine 使用这个 bot，并复制[连接 Agent](agents.md#给-agent-固定回信指令)中的指令。检查 Routine URL 和 Authorization 与环境变量一致。更改配置或部署环境后重启 Relanox。

## 6. 收到第一条回信

打开 Telegram bot 的私人聊天，用允许的用户在已绑定聊天发送 `你好，请简单打个招呼。`。Grok 调用 `relanox_send_message`，Relanox 将答案发回 Telegram。

```sh
node apps/cli/dist/main.js status --config relay.json --endpoint-id grok-main
```

来信记录的 `accepted` 表示 Routine 已接收通知；回信记录的 `sent` 表示 Telegram 已接收回信。如果只看到来信，检查 Grok MCP 连接和固定回信指令。如果没有来信记录，检查 webhook、用户 ID 和聊天绑定。[部署与备份](operations.md#查找并恢复卡住的消息)介绍其他状态和恢复方法。

按[修改配置](configuration.md)添加聊天，在[渠道接入](channels/index.md)选择平台，按[收发图片和文件](media.md)配置附件。
