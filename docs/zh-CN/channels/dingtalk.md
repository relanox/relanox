# 钉钉应用机器人

通过钉钉应用机器人进行私聊提问和群聊对话。

## 准备账号

创建应用机器人，记录 Client ID 和 Robot Code，将应用密钥保存到 `DINGTALK_APP_SECRET`。启用 Stream 接收方式，授予机器人单聊/群聊独立发送消息及媒体下载/上传权限。将它加入目标群组，并开放给所需员工。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **钉钉**，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段 | 填写内容               |
| ---------- | ---------------------- |
| 客户端 ID  | 上一步取得的客户端 ID  |
| 机器人代码 | 上一步取得的机器人代码 |

将下载的配置保存为 `relanox.json`，并按接入教程在服务器上设置密钥。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#dingtalk)。

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

允许发送者使用回调中的不透明 `senderId`，包括前缀。私聊 「聊天 ID」使用 `senderStaffId`，群聊使用 `conversationId`（开放会话 ID）。从应用机器人的消息事件取得这些值。发送者 ID 和私聊 ID 用途不同，请分别复制对应字段。

需要在 Relanox 收到该会话消息前向已绑定目标发送时，在下载配置的账号 `config` 中加入 `recipientTypes`：将「聊天 ID」映射为员工单聊的 `single` 或开放会话群聊的 `group`。省略此配置时，Relanox 从已验证的消息事件取得接收方类型。机器人仍需独立发送消息 API 权限和目标访问权限。「话题 / 线程 ID」留空。参见[手写配置示例](../reference/channels.md#dingtalk)。

## 启用连接

保存账号配置后启动 Relanox。它会使用应用凭据自动建立 Stream 连接，请保持出站 HTTPS 和 WebSocket 可用。轮换应用密钥后请重启 Relanox，让 Stream SDK 取得新凭据。

channel 使用官方 [`dingtalk-stream` SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) 处理建连、心跳、恢复、回调分发和 ACK 帧，并使用 `@alicloud/dingtalk` 处理 OAuth、消息发送和下载地址。Stream 精确锁定官方 [2.1.7-beta.1 预发布版](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/releases/tag/v2.1.7-beta.1)，该版本修复了取消时的连接清理，并保证延迟回调的 ACK 留在接收它的 socket。恢复和队列行为遵循 SDK 默认规则。接受的回调在持久化入库后确认；已知权限或不支持输入的拒绝使用 SDK 的成功 ACK 终止重投。存储或下载失败保持未确认，等待平台重投。Core 继续管理权限、绑定和发送重试。SDK 消息 POST 重试已关闭；生成的 gateway 不暴露 `Retry-After`，限流使用 Core 的 1 秒重试间隔。已发出的 OpenAPI 调用可能在取消期间完成；媒体下载与旧版上传仍支持中止。

## 发送第一条消息

由允许的员工向应用机器人发送“你好”。群聊中请 @ 机器人，让群消息事件包含对机器人的提及。

## 图片和文件

当前应用机器人发送接口没有已验证的原生引用参数。Agent 可以提供 `reply.requestId`，将回复关联到选定请求并追踪完成状态，但钉钉会将其作为普通会话消息发送，不显示引用气泡。省略 `reply` 也普通发送。[官方 SDK 请求模型](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/robot_1_0/client.go)定义了群聊和单聊接口支持的参数；Relanox 不会把消息 ID 填入未经文档确认的字段。

可发送图片、音频、视频、文件或富文本消息。常见格式包括 JPEG/PNG/GIF/BMP 图片、MP4 视频、AMR 音频和办公文档。Core 媒体预算为 100 MiB；每次上传的大小和格式由钉钉校验，低于该预算的文件也可能被平台拒绝。普通媒体和富文本图片上传的拒绝结果均交回 Core。生成的 SDK 未覆盖旧版 `/media/upload` multipart 接口，因此仅此上传保留窄 HTTP 调用。入站下载继续执行 URL、重定向和字节上限保护。生成音频需带时长；视频还需图片预览和时长。

## 常见问题

机器人已连接但没有回复时，检查独立发送消息 API 权限和员工/群组可用范围。私聊被过滤时，分别核对允许列表的 `senderId` 与绑定的 `senderStaffId`。群组失败时，检查 Robot Code 和机器人是否在群内。
