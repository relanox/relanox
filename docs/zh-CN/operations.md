# 部署与备份

在服务器持续运行 Relanox，让数据库跨重启保留，并为业务 HTTP 配置 HTTPS。[快速开始](getting-started.md)介绍账号接入，本页介绍部署和维护。

## 使用 Docker Compose 启动

安装支持 Compose 的 Docker，克隆仓库，在根目录准备文件：

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
mkdir -p deploy
cp examples/relanox.sqlite.json deploy/relanox.json
```

PowerShell 使用 `New-Item -ItemType Directory -Force deploy` 和 `Copy-Item examples/relanox.sqlite.json deploy/relanox.json`。

如果已经下载了生成配置，将该文件复制到 `deploy/relanox.json`，不要用示例覆盖。

按[修改配置](configuration.md)编辑 `deploy/relanox.json`。随仓库提供的 Compose 文件需要：

- `server.host`：`0.0.0.0`。
- `relay.storage.config.filename`：`/data/relanox.sqlite`。
- `publicUrl`：公开 HTTPS 地址，例如 `https://relay.example.com`。
- 自己的发送者 ID 和准确聊天绑定。

在仓库根目录创建受保护的 `.env` 文件，写入配置引用的变量。Telegram/Grok 示例：

```dotenv
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET=REPLACE_WITH_WEBHOOK_SECRET
RELANOX_AGENT_1_MCP_TOKEN=REPLACE_WITH_MCP_TOKEN
RELANOX_AGENT_1_ROUTINE_URL=REPLACE_WITH_COMPLETE_ROUTINE_URL
RELANOX_AGENT_1_ROUTINE_AUTHORIZATION='REPLACE_WITH_COMPLETE_AUTHORIZATION_VALUE'
```

替换全部占位符。值含空格或 `$` 时按 Compose 的环境文件语法使用引号。限制文件仅部署人员可读；POSIX 系统可用 `chmod 600 .env`。提交代码时排除这个文件和账号配置。

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 100 relanox
```

Compose 构建本地镜像，启动服务，并在异常退出后重启。存储初始化和首次处理批次结束后，等待健康检查变为 healthy。

业务 HTTP 映射到主机 `127.0.0.1:8787`。JSON 以只读方式挂载到 `/config/relanox.json`；命名卷在 `/data` 保存数据。管理端口位于容器内的 `127.0.0.1:8788`，在容器内运行管理命令：

```sh
docker compose exec relanox node dist/main.js doctor --config /config/relanox.json --management-url http://127.0.0.1:8788
docker compose exec relanox node dist/main.js status --config /config/relanox.json --limit 100
```

获取企业微信 WebSocket 模式的聊天和发送者 ID 时，先停止使用同一个 bot 的运行进程，提供 `WECOM_BOT_SECRET`，再运行下方发现命令。绑定未完成或 Agent 凭据未填写的配置也可使用。向 bot 发送消息，命令只输出 ID，不修改配置。详见[企业微信](channels/wecom.md)。

```sh
node apps/cli/dist/main.js discover --config relanox.json --account wecom-main --timeout 120
```

超时范围为 1–600 秒，默认 120 秒；可按 Ctrl+C 提前停止。

## 提供 HTTPS 地址

将公开域名指向主机，使用带可信 TLS 证书的反向代理。同一主机上的 Caddy 可以使用以下 `Caddyfile`：

```caddyfile
relay.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

替换域名，开放证书签发和 HTTPS 访问所需的 TCP 80/443 端口，并按 Caddy 安装说明配置服务。代理位于另一容器时，需要通过 Docker 网络访问 Relanox 服务。

保留公开 Host 头，使其匹配 `publicUrl` 中的主机名。在公开地址下注册渠道 webhook 和 Agent MCP URL。转发业务 HTTP，管理端口保持回环访问。渠道需要公开附件 URL 时，按[收发图片和文件](media.md)配置。

Grok MCP URL 含有密钥 token，请勿分享；在反向代理中关闭 `/agents/grok/mcp/` 路径的访问日志，或移除日志中的 token 路径段。

## 停止、重启和升级

```sh
docker compose stop relanox
docker compose start relanox
docker compose restart relanox
```

Compose 允许 20 秒停机；Relanox 默认关闭超时为 15 秒。需要更长正常停机时间时同时增加二者。

升级前备份数据库与配置，用 `git rev-parse HEAD` 记录当前提交，然后：

```sh
docker compose stop relanox
# 更改仓库前先按下方步骤备份。
git pull --ff-only
docker compose build
docker compose up -d
docker compose exec relanox node dist/main.js doctor --config /config/relanox.json --management-url http://127.0.0.1:8788
```

升级后在每个已配置渠道发送短消息验证回信。源码安装则停止进程、备份、更新仓库、运行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再使用原工作目录与环境启动 CLI。

`docker compose down` 保留数据卷。只有确定永久删除该安装的消息和连接状态时，才使用 `docker compose down --volumes`。

## 备份和恢复

SQLite 先正常停止，再备份整个 `/data` 目录，包括仍然存在的 `-wal`、`-shm` 文件。以下 PowerShell 命令适用于仓库提供的 Compose：

```powershell
docker compose stop relanox
$backupPath = Join-Path (Get-Location) ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $backupPath | Out-Null
$containerId = docker compose ps -a -q relanox
docker cp "${containerId}:/data/." $backupPath
Copy-Item deploy/relanox.json (Join-Path $backupPath 'relanox.json')
docker compose start relanox
```

限制备份访问权限，它包含聊天内容、附件和连接状态。另行保护配置使用的环境密钥副本。

先在独立安装测试恢复，恢复文件时保持服务停止。对于随仓库提供的 Compose 卷，创建未启动容器，再复制数据库文件到 `/data`：

```powershell
# 替换为选定的备份目录。
$restorePath = 'C:/backups/relanox/20261011-120000'
docker compose create relanox
$containerId = docker compose ps -a -q relanox
Get-ChildItem -LiteralPath $restorePath -Filter 'relanox.sqlite*' | ForEach-Object {
  docker cp $_.FullName "${containerId}:/data/"
}
docker compose run --rm --no-deps --user root --entrypoint sh relanox -c 'chown -R node:node /data'
```

更改过数据库名时相应修改筛选条件。恢复到空数据卷，避免较新的数据库或 WAL 文件与备份混用。将 JSON 恢复到 `deploy/relanox.json`，单独提供密钥。用 `docker compose run --rm relanox doctor --config /config/relanox.json` 检查离线存储。在启动恢复实例前，先停止使用相同真实渠道凭据的原实例。确认就绪健康并收到新回信后恢复正常使用。

PostgreSQL 使用一致性数据库工具：

```sh
pg_dump --format=custom --file=relanox.dump "$RELANOX_DATABASE_URL"
pg_restore --dbname="$RESTORE_DATABASE_URL" relanox.dump
```

以上使用 POSIX 变量；PowerShell 使用 `$env:RELANOX_DATABASE_URL` 和 `$env:RESTORE_DATABASE_URL`。恢复到独立空数据库，保留配置的 schema，更新恢复实例的连接字符串。也可以使用数据库服务商的备份恢复工具。

## 查找并恢复卡住的消息

源码安装使用 `node apps/cli/dist/main.js`。Docker 中：

```sh
docker compose exec relanox node dist/main.js status --config /config/relanox.json --endpoint-id agent-1
```

| 状态                      | 检查事项                                                    |
| ------------------------- | ----------------------------------------------------------- |
| 没有来信记录              | webhook/连接、发送者名单、准确聊天和话题绑定                |
| 来信 `due`                | Agent 凭据、Routine 可用性或 dot 订阅；日志可查看安排的重试 |
| 来信 `accepted`，没有回信 | MCP 连接元数据、连接状态和远端执行                          |
| 来信或回信 `rejected`     | 重试前修正报告的权限或配置问题                              |
| 回信 `pending`            | 平台连接、权限、重试等待时间，以及同一来信更早的未完成回信  |
| 回信 `sent`               | 平台已接收，检查原聊天或话题                                |
| `unknown`                 | 重复操作前检查 Agent 或平台上是否已经完成                   |

临时故障会自动重试。需要再次通知 Agent 时，从 status 读取来信的 `requestId` 和当前 `version`，代入：

```sh
docker compose exec relanox node dist/main.js requeue --config /config/relanox.json --kind request --id REQUEST_ID --expected-version 4
```

需要重新投递保留的回信时，使用其 `deliveryId` 和当前 `version`：

```sh
docker compose exec relanox node dist/main.js requeue --config /config/relanox.json --kind delivery --id DELIVERY_ID --expected-version 7
```

版本号填写实际当前值。恢复报告 conflict 时，重新查看 status 再决定重试。

`unknown` 表示外部操作可能已完成，但响应丢失。先检查实际结果。确定需要重复时加 `--acknowledge-unknown`，这可能重复回信或 Agent 工作。重启会保留记录供检查。恢复 request 会再次发送原通知，恢复 delivery 会继续发送已保存的回信。

更改过 bot/app 身份时，恢复排队回信前还原原账号设置与凭据身份。相同身份下轮换 token 可以使用。已有消息保留原目标；新身份使用新的账号与 Agent 连接。

## 按需保留内容

选择保留时长。例如 PowerShell 中清理 30 天前已完成且符合条件的内容：

```powershell
$before = [DateTimeOffset]::UtcNow.AddDays(-30).ToUnixTimeMilliseconds()
docker compose exec relanox node dist/main.js cleanup --config /config/relanox.json --before $before --limit 1000
```

需要时分批再次运行。清理保留未完成工作和防止重复处理的记录，删除符合条件的旧文字、附件字节及相关内容。为用户下载留出足够时间：附件清理后公开 URL 失效。备份使用单独的保留策略。

## 监控安装

轮询本地 `/health/ready` 检查就绪状态，`/health/live` 检查进程健康。Docker 内置检查覆盖就绪状态，`doctor` 还检查环境变量与存储。需要集中监控时，按[日志与运行状态](reference/observability.md)配置指标采集。

[Prometheus 告警示例](https://github.com/relanox/relanox/blob/master/deploy/prometheus-alerts.yml)覆盖处理与连接健康。将规则装入监控系统，调整延迟阈值，并在那里配置告警接收者。同时监控指标抓取可用性，使进程不可达时也能告警。
