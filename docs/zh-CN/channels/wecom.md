# 企业微信智能机器人

在企业微信私聊和群聊中使用智能机器人。

## 准备账号

创建并启用智能机器人，在平台设置中选择 WebSocket 长连接或 HTTP 回调。使用 WebSocket 时，记录 Bot ID，将密钥保存到 `WECOM_BOT_SECRET`。使用 HTTP 回调时，记录 Bot ID、Token 和 EncodingAESKey，将后两项分别保存到 `WECOM_TOKEN` 和 `WECOM_ENCODING_AES_KEY`。向所需成员开放机器人，并将它加入目标群组。同一个机器人运行一个 Relanox 进程。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **企业微信**，将「连接模式」设置为对应的 `websocket` 或 `webhook`，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段 | 填写内容              |
| ---------- | --------------------- |
| 机器人 ID  | 上一步取得的机器人 ID |

将下载的配置保存为 `relanox.json`，并按接入教程在服务器上设置密钥。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#wecom)。

## 使用 WebSocket 发现用户和群组 ID

发现命令要求使用 WebSocket 模式。使用 HTTP 回调模式时，从企业通讯录取得成员 userid，从平台回调事件取得会话 ID。

先在配置器中填写机器人 ID，保留默认凭据变量名，下载当前草稿为 `relanox.json`。允许用户和聊天 ID 暂时留空。在运行命令的终端设置 `WECOM_BOT_SECRET`。

开始前先停止使用同一机器人的服务：企业微信会在新进程连接时替换原有连接。运行：

默认账号名为 `wecom-main`；如果添加了其他机器人，命令中的账号名应改为下载配置里对应机器人的账号 ID。

```sh
node apps/cli/dist/main.js discover --config relanox.json --account wecom-main --timeout 120
```

等待终端显示 `discovery_connected`，再向机器人发送私聊消息，或在目标群中 @ 机器人。终端会显示会话和发送者 ID。

需要其他成员的 userid 时，让相应成员各发送一条消息。使用这些 ID，而非显示名称。

将输出的 `senderId` 填入配置器的「允许使用的用户 ID」，`chatId` 填入「聊天 ID」。完成其他信息并重新下载配置。命令 120 秒后退出，也可按 Ctrl+C 提前停止。验证配置后重新启动服务：

```sh
node apps/cli/dist/main.js validate --config relanox.json
```

## 启用连接

使用 WebSocket 模式时，启动 Relanox 后会自动连接机器人。保持进程运行。

需要在 Relanox 收到该会话消息前通过 WebSocket 向已绑定会话发送时，在下载配置的账号 `config` 中加入 `recipientTypes`，将会话的「聊天 ID」映射为 `single` 或 `group`。省略时，Relanox 从已验证的消息事件取得类型。使用准确的成员 userid 或群聊 ID，「话题 / 线程 ID」留空。参见[手写配置示例](../reference/channels.md#wecom)。

使用 HTTP 回调模式时，先通过公网 HTTPS 地址提供 Relanox 服务，再在机器人设置中填写生成的回调 URL：`https://your-host/channels/wecom-main/webhook`。将 `wecom-main` 替换为账号 ID。Token 和 EncodingAESKey 必须与服务环境一致，URL 验证成功后保存平台设置。

HTTP 模式需要真实、已验证的消息回调以及可用的回复窗口。仅配置聊天 ID 无法建立回复目标；`recipientTypes` 只用于 WebSocket 模式。

两种模式都需要公网 HTTPS 地址供 dot 或 Grok 访问 MCP。

## 发送第一条消息

向机器人私聊发送“你好”。在绑定群组中 @ 机器人提问，并确认你的企业成员 userid 已获允许。

## 图片和文件

Agent 提供 `reply.requestId` 时，WebSocket 模式使用对应来信的原始回调请求 ID 发送原生响应；不提供 `reply` 时发送独立消息。文本响应一次性提交已完成的原生 stream 消息，不发送增量流式内容。这种原生响应上下文不保证客户端显示引用气泡。HTTP 模式在有效回复窗口内完成选定的回调，每条来信只允许一次最终回复；即使省略 `reply`，该模式也没有独立发送接口。

WebSocket 模式可发送图片、视频、文件或图文混合消息；语音输入会将识别文字交给 Agent。媒体下载资源五分钟后过期，发送时保持 Relanox 在线。回复可包含 10 MB 内的 PNG/JPEG/GIF 图片和 MP4 视频、2 MB 内的 AMR 音频、20 MB 内的文件，同时受 Relanox 限制。

HTTP 回调模式接收文本、图片、视频、文件、图文混合消息和语音识别文字。每条来信发送一次最终 Markdown 回复，可带最多 10 张 PNG/JPEG 图片，每张不超过 10 MB，同时受 Relanox 限制。回复文字总长度不超过 20,480 个 UTF-8 字节。回复准备好后会一次显示。等待期间请保持 Relanox 在线，并确保回调地址可访问。此模式不支持回复音频、视频或文件。

两种模式都保留企业微信支持的 Markdown 格式。

## 常见问题

连接被替换时，停止使用同一机器人的其他进程，再重启本实例。群组提问没有响应时，检查机器人是否在群内并 @ 它。更换密钥后更新服务的环境变量，再重启服务。

发现命令未输出会话时，核对 Bot ID 与密钥、成员访问权限和群组成员关系，并在命令运行期间重新发送消息。仅正常超时退出不能证明平台认证成功。

回调 URL 验证失败时，检查公网 HTTPS 可达性、URL 中的账号 ID，以及 Token 和 EncodingAESKey。
