# 发送第一条消息

使用 Go 1.27.2 构建 Relanox，配置一个原生通道和一个已有的云端 Agent，再绑定准确的
会话 ID。服务需要持续运行，以保持原生连接并处理持久化队列。

## 构建当前代码

```sh
git clone https://github.com/relanox/relanox.git
cd relanox
go build -trimpath -o bin/relanox ./cmd/relanox
```

Windows 使用 `-o bin/relanox.exe`。预编译二进制产物与容器命令见[部署说明](deployment.md)。

## 创建配置

可以使用[连接配置器](connect.md)选择账号、Agent 和会话绑定，并下载 `relanox.json`。
下面的 CLI 示例也可以直接创建相同的原生配置。

准备一个公网 HTTPS 地址，例如 `https://relay.example.com`。反向代理负责 TLS，
并向应用监听保留原始 Host。

```sh
bin/relanox init --config relanox.json --public-url https://relay.example.com
bin/relanox setup --config relanox.json
```

引导依次询问通道、凭据、允许的原生发送者 ID、Agent 和需要绑定的会话。选择微信
会直接进入原生扫码登录，并保存确认的 bot、用户和实际 token。Google Chat 导入
服务账号 JSON；Muse 使用已有的配对凭据目录。完成后会打印 MCP 和原生回调 URL。

凭据保存在配置旁的私有文件中；非空环境变量可以覆盖文件值。每次修改配置都会保留
原文件备份，并检查并发修改。[配置说明](configuration.md)介绍完整 JSON 和脚本用法。

## 连接外部应用

Telegram 需要先通过 BotFather 创建 bot，并提供 token 和数字用户 ID。将打印出的
回调地址登记到 Telegram `setWebhook`，把账号 `webhookSecret` 引用文件中的值
设置为 `secret_token`。通道不会代替用户登记 webhook。其他回调平台也需要在各自
控制台设置相应地址，见[原生通道](channels.md)。

dot 添加打印出的 MCP URL，并使用生成的端点凭据完成 OAuth。Grok 先创建由 webhook
触发的 Routine，输入 URL 和完整 Authorization 值，再连接使用 bearer 凭据的 MCP。
Muse 先完成设备配对，再配置已有凭据目录和 MCP，见[云端 Agent](agents.md)。

## 校验并运行

```sh
bin/relanox validate --config relanox.json
bin/relanox run --config relanox.json
```

`validate` 完全离线，不打开数据库，也不连接平台。`run` 创建配置中的 SQLite 数据库，
或在已有的空 PostgreSQL 数据库 / schema 中初始化表，再启动所选原生组件。不兼容的
旧库会被拒绝；使用非默认 schema 时，需要先创建该 schema。

使用允许的发送者，在已绑定会话中发送消息。Agent 应当携带触发消息准确的 `requestId`
回复，以保留原生会话、线程和引用关系。本地协议测试不代表任意真实账号已具备所需权限。

```sh
bin/relanox status --config relanox.json --json
bin/relanox doctor --config relanox.json --management-url http://127.0.0.1:8788
```

状态默认隐藏正文，只有 `--include-content` 才会输出。Doctor 检查凭据和已有数据库，
不启动通道连接。恢复、备份和部署见[运维](operations.md)与[部署](deployment.md)。
