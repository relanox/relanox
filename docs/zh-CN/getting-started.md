# 快速开始

Relanox 是常驻 Node 消息网关，将渠道文字持久交给用户已有的 dot 或 Grok Bot。先准备渠道账号和托管 Agent，再配置身份和凭据。账号权限、公开 HTTPS 和远端 Agent 配置属于部署前提；本地配置校验不证明真实账号兼容性。

## 从源码安装

使用 Node 26.11.1 和 `package.json` 指定的 pnpm 版本，在仓库根目录运行：

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
pnpm install --frozen-lockfile
pnpm build
```

构建后通过 `node apps/cli/dist/main.js` 运行 CLI；CLI 包也声明了 `relanox` 可执行入口。

## 配置 Telegram 与 Grok

将 [SQLite 示例](https://github.com/relanox/relanox/blob/master/examples/relanox.sqlite.json) 复制为 `relay.json`。它包含一个 Telegram 账号、一个 Grok endpoint 和对应绑定。替换以下字段：

| 字段                        | 实际值                                   |
| --------------------------- | ---------------------------------------- |
| 账号 `allowedSenders`       | 允许使用网关的 Telegram 发送者 ID        |
| 绑定 `chatId`               | 精确的目标聊天 ID；话题还需要 `threadId` |
| endpoint `mcp.allowedHosts` | 公开 MCP 主机名，非默认端口也要包含      |
| SecretRef 的 `env`          | 传给进程的环境变量名                     |
| SQLite `filename`           | 相对进程工作目录的持久文件路径           |

为示例引用的五个变量设置凭据，避免将密钥写入 JSON 或命令历史。例如 PowerShell 可以通过安全提示读取：

```powershell
$secret = Read-Host 'Telegram bot token' -AsSecureString
$env:TELEGRAM_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
```

同样设置 `TELEGRAM_WEBHOOK_SECRET`、`GROK_MCP_TOKEN`、`GROK_ROUTINE_URL` 和 `GROK_ROUTINE_AUTHORIZATION`。MCP 变量存原始 token；Routine 授权保存界面提供的完整值。Routine URL 本身可能包含密钥。

```sh
node apps/cli/dist/main.js validate --config relay.json
node apps/cli/dist/main.js run --config relay.json
```

`run` 自动创建缺失的存储表和索引。保持终端运行，在具有相同环境变量的另一终端检查：

```sh
node apps/cli/dist/main.js doctor --config relay.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relay.json
```

第一次 `run` 前，新数据库可能使 `doctor` 返回不健康，因为诊断不初始化存储。首个持久工作批次成功前，就绪接口返回 503。

## 连接外部服务

通过可信反向代理提供 HTTPS 业务入口，将 Telegram webhook 注册到 `/channels/telegram-main/webhook`，并设置对应的 webhook secret。账号设置和聊天/话题身份见 [Telegram](channels/telegram.md)。让 Grok 通过 Bearer token 使用 `/agents/grok/mcp/grok-main`，并按 [Agent](agents.md) 设置 Routine URL 和授权。远端固定指令将正文视作不可信数据，使用事件中的 `replyTo` 调用 `relanox_send_message` 回复。

从允许的发送者在绑定聊天发送文字。通过 `status` 区分通知状态与出站发送状态。Routine HTTP 回执表示通知被接收；每次鉴权 MCP send 独立入队一条消息，`queued` 不表示已送达。

## 更多配置

[配置与 CLI](configuration.md) 说明绑定、存储和管理命令；[Agent](agents.md) 说明 dot 订阅和 Grok；[全部渠道示例](https://github.com/relanox/relanox/blob/master/examples/relanox.all-channels.json) 包含十五个渠道配置，保留所选账号、endpoint 和绑定，并阅读对应渠道指南。[运维](operations.md) 说明容器、备份和恢复。
