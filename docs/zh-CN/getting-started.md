# 快速开始

将 Telegram bot 连接到 Grok Bot，发送消息，并在同一个聊天收到答案。使用 dot 时，安装完成后按[连接 Agent](agents.md)继续。

## 1. 准备账号

准备以下内容：

- 从 BotFather 获取的 Telegram bot token、你的用户 ID 和目标聊天 ID。私人聊天的 chat ID 通常就是用户 ID。群组和话题设置见 [Telegram](channels/telegram.md)。
- Grok Bot 桌面客户端，并登录你的付费 Cursor 账号。下面会创建 webhook 例行任务。
- 可以持续运行 Relanox 的机器，以及公开 HTTPS 地址，例如 `https://relay.example.com`。[部署与备份](operations.md)提供反向代理示例。
- 源码安装需要 Git、Node.js 26.11.1 和 pnpm 12.11.2。[部署与备份](operations.md)也提供 Docker 安装方式。

## 2. 安装并准备配置

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

打开[连接配置器](connect.md)，填写公开 HTTPS 地址，将默认 Agent 从 dot 切换为 Grok，启用 Telegram。填写允许使用的 Telegram 用户 ID 和私人聊天 ID，为这个聊天选择这个 Grok Agent。保留生成的环境变量名称，将下载的 `relanox.json` 放在仓库根目录。

打开**你的接入教程**，关闭或刷新页面前保存生成的 MCP 密码。如果仍有草稿提示，先补全对应信息。教程会列出此次配置需要的变量和连接地址。使用仓库示例手动配置的方法见[配置参考](reference/configuration.md)。

设置环境变量前，先创建 Grok 例行任务。在负责回复 Telegram 消息的 Bot 对话中发送：

> 创建一个仅由 webhook 触发的例行任务，按 Relanox MCP 说明处理收到的用户消息。不要添加定时计划。

点击 Bot 名称，打开 **详情 → 例行任务**，选择新建的任务。从 **Webhook** 区域复制 **POST 到** 作为 Routine URL。Authorization 值为 `Bearer <密钥>`；如果复制的是显示的标头，去掉开头的 `Authorization:` 字段名。保留这两个值，下一步需要使用。

## 3. 提供环境变量

设置接入教程列出的全部环境变量。Telegram bot token 来自 BotFather；webhook 密钥使用独立随机值；MCP 密码使用教程生成的值；Routine URL 和 Authorization 使用 Grok 提供的完整值。可以这样生成 webhook 密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

下面的 PowerShell 命令使用配置器中一个 Telegram 账号和一个 Grok Agent 的默认变量名。如果改了名称或添加了 Agent，请按教程列出的准确名称调整。

在 PowerShell 中通过提示输入，避免把密钥直接写入命令历史：

```powershell
foreach ($name in @('TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'RELANOX_AGENT_1_MCP_TOKEN', 'RELANOX_AGENT_1_ROUTINE_URL', 'RELANOX_AGENT_1_ROUTINE_AUTHORIZATION')) {
  $value = Read-Host $name -AsSecureString
  [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $value).Password, 'Process')
}
```

服务部署时通过受保护的服务环境设置提供变量。Docker 使用[部署与备份](operations.md)中的 `.env` 文件。源码启动读取当前终端环境，启动前先载入变量。Relanox 不会自动读取 `.env` 文件。

## 4. 启动 Relanox

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
```

校验成功会输出 `ok: true` 和账号、Agent 数量。启动成功会输出 `started`。保持终端运行。

另开终端，提供相同环境变量并运行：

```sh
node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
```

启动服务后再运行检查，等待 `ok` 为 `true`。

## 5. 接通 Telegram 和 Grok

按[部署与日常管理](operations.md)让公网 HTTPS 地址可访问。从**你的接入教程**复制 Telegram 回调地址，替换下方 `$webhookUrl` 的值，在已设置环境变量的 PowerShell 终端中注册 webhook：

```powershell
$webhookUrl = 'https://relay.example.com/channels/telegram-main/webhook'
$body = @{
  url = $webhookUrl
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @('message')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType 'application/json' -Body $body
```

Telegram 应返回 `ok: true`。共享截图和输出前去掉 token。

将第 2 步创建的例行任务接到 Relanox。在同一 Cursor 账号的控制台打开 **Plugins & MCPs → Add → Custom MCP**。类型保持 **URL**，将**你的接入教程**中的完整 Grok MCP 地址粘贴到 **Server URL**。**HTTP headers、Client ID、Client Secret** 留空，点击 **Add MCP**。回到 Grok Bot，打开 **连接应用 → 你的插件**，确认连接已就绪。详细步骤见[连接 Grok](agents.md#连接-grok)。

修改配置或环境变量后重启 Relanox。

## 6. 收到第一条回信

打开 Telegram bot 的私人聊天，用允许的用户在已绑定聊天发送 `你好，请简单打个招呼。`。确认答案回到同一个 Telegram 聊天。

```sh
node apps/cli/dist/main.js status --config relanox.json --endpoint-id agent-1
```

来信记录的 `accepted` 表示 Routine 已接收通知；回信记录的 `sent` 表示 Telegram 已接收回信。如果只看到来信，检查 Grok MCP 连接和 Routine 执行情况。如果没有来信记录，检查 webhook、用户 ID 和聊天绑定。[部署与备份](operations.md#查找并恢复卡住的消息)介绍其他状态和恢复方法。

按[修改配置](configuration.md)添加聊天，在[渠道接入](channels/index.md)选择平台，按[收发图片和文件](media.md)配置附件。
