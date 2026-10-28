# 原生通道

账号使用各平台原生协议，保留原生用户、会话、线程和消息 ID。每个账号都需要非空的
发送者允许列表，以及匹配的会话绑定。发现 ID 本身不会授权接收消息。

## 账号选项

下表中的凭据字段使用[凭据引用](configuration.md#凭据)。`account add` 提供交互表单；
`--native-config` 可以用 JSON 对象传入其他原生选项。

| 通道 | 必需原生选项 | 连接及限制 |
| --- | --- | --- |
| <span id="telegram">Telegram</span> | `botToken`、`webhookSecret` | 原生 webhook / Bot API；向 Telegram 登记回调与 `secret_token`。话题保留线程 ID。 |
| <span id="discord">Discord</span> | `botToken` | Gateway / REST；需要相应 intents 和频道权限。短期 nonce 不能提供持久重试保证。 |
| <span id="slack">Slack</span> | `botToken`、`appId`，以及 `appToken` / `signingSecret` 之一 | Socket Mode 使用 app token，签名 Events API 使用 signing secret；安装的原生 team、bot、app 身份必须匹配。 |
| <span id="feishu">飞书 / Lark</span> | `appId`、`tenantKey`、`appSecret`、`verificationToken`、`encryptKey` | 签名、加密回调和 IM API；Lark 设置 `domain: "lark"`。 |
| <span id="wecom">企业微信</span> | 两种模式都需要 `botId`；websocket 模式另需 `secret` | webhook 模式使用 `mode: "webhook"`、`token`、`encodingAESKey`，不能配置 `secret` 或 `recipientTypes`；在平台回调窗口内被动完成最终回复。 |
| <span id="wechat">微信</span> | `wechat-login` 自动保存 | 原生扫码与私聊轮询。发送需要从已接收的入站消息中取得上下文令牌；仅添加会话绑定不能建立可发送目标。 |
| <span id="dingtalk">钉钉</span> | `clientId`、`clientSecret`、`robotCode` | Stream 回调与机器人 REST；群消息需要提及机器人。 |
| <span id="qq">QQ</span> | `appId`、`clientSecret` | Gateway 和 v2 消息；可设置 `environment: "sandbox"`。上传后重新检查被动回复权限。 |
| <span id="msteams">Microsoft Teams</span> | `appId`、`botId`、`tenantId`、`appSecret`、`trustedServiceOrigins` | 认证的 Bot Framework 活动，检查租户、bot 和受信原生服务地址；个人文件需要接收者授权。 |
| <span id="whatsapp">WhatsApp</span> | `phoneNumberId`、`businessAccountId`、`appSecret`、`verifyToken`、`accessToken` | 签名 Cloud API webhook，仍受客户服务窗口限制。 |
| <span id="matrix">Matrix</span> | `homeserver`、`accessToken` | mautrix 原生 `/sync`、媒体和事务 API；不支持端到端加密房间：不转发其入站消息，出站发送会被拒绝。 |
| <span id="mattermost">Mattermost</span> | `serverUrl`、`token` | 原生 v4 REST / WebSocket，使用实例 HTTPS 地址和 bot / 用户访问 token。 |
| <span id="googlechat">Google Chat</span> | `serviceAccount` | 原生认证交互事件与 Chat REST；在应用中配置打印出的 webhook URL 与 audience。 |
| <span id="line">LINE</span> | `channelSecret`、`accessToken` | 签名 Messaging API webhook，通过 SDK push 消息发送，保留原生引用令牌和持久化重试键。 |
| <span id="signal">Signal</span> | `serviceUrl`、`account` | 已有 signal-cli daemon：`/api/v1/rpc` JSON-RPC 与 `/api/v1/events` SSE 事件，可配置 `selfUuid` 与认证引用。 |
| <span id="irc">IRC</span> | `server`、`nick` | TLS IRC/IRCv3，可选 server password 和 SASL；仅文本。 |

企业微信 WebSocket 模式、钉钉和 QQ 的 `recipientTypes` 可以声明尚未接收消息时主动发送所需的原生
接收者类型；配置必须与已知的原生身份一致。测试或桥接端点的本地 HTTP 许可需要
显式开启；不可信媒体 URL 不会自动获得访问私网的权限。

## 回调路径与 ID

以下路径前加 `http.publicUrl`；`{account}` 是本地账号 ID。

| 通道 | 入站回调路径 | binding / 发送者 ID |
| --- | --- | --- |
| Telegram | `/channels/telegram/{account}/webhook` | 数字会话和用户 ID 字符串；可选数字话题 `threadId`。 |
| Discord | 无，出站 Gateway 连接 | 原生频道、线程和用户 snowflake。 |
| Slack | 签名 Events API 为 `/channels/slack/{account}/events`；Socket Mode 无 | 原生频道、用户 ID 和原样保留的消息 `thread_ts` 时间戳字符串。 |
| 飞书 | `/channels/feishu/{account}/webhook` | `chat_id`、发送者 `open_id`、可选原生 `thread_id`。 |
| 企业微信 | webhook 模式为 `/channels/wecom/{account}/webhook`；socket 无 | 私聊为 `userid`，群为 `chatid`；允许列表使用发送者 `userid`。 |
| 微信 | 无，原生轮询 | 配对确认的原生用户 ID，按平台格式保留聊天和发送者身份。 |
| 钉钉 | 无，出站 Stream 连接 | 私聊 `senderStaffId`，群聊 `conversationId`；允许列表用 `senderId`。 |
| QQ | 无，出站 Gateway 连接 | 原生 C2C 用户或群 openid，保留原生发送者 openid。 |
| Teams | `/channels/msteams/{account}/activities` | `conversation.id`、`from.id`；父活动 `replyToId` 可作为线程。 |
| WhatsApp | `/channels/whatsapp/{account}/webhook` | 原生用户和电话号码标识，不使用展示格式。 |
| Matrix | 无，原生 `/sync` 轮询 | `!room:server` 房间、`@user:server` 用户、可选线程根事件 ID。 |
| Mattermost | 无，出站原生 WebSocket | 原生 26 字符频道、用户 ID；线程使用根帖子 ID。 |
| Google Chat | `/channels/googlechat/{account}/webhook` | `spaces/...`、`users/...`、可选 `spaces/.../threads/...`。 |
| LINE | `/channels/line/{account}/webhook` | 原生用户、群组或房间 ID；允许列表使用发送者 `userId`。 |
| Signal | 无，出站 daemon SSE 事件 | `direct:<sender>` 或 `group:<groupId>`；发送者优先 UUID，再回退到平台号码或 source。 |
| IRC | 无，出站 IRC 连接 | `#room` 等频道名，或私聊 `dm:<nick>`。发送者 ID 使用 `account:<account>`；详见下方 IRC 说明。 |

Socket / 轮询通道不需要入站回调，但其云端 MCP 与公开媒体 URL 仍可能需要公网 HTTPS。

## 配对与发现

```sh
relanox wechat-login --account wechat --config relanox.json
relanox discover --account wecom --config relanox.json --timeout 2m
```

微信在 stderr 绘制可扫描的二维码，在 stdout 输出登录事件。这两个命令的超时既接受
`--timeout 120` 这样的秒数，也接受 `--timeout 2m` 这样的时长。
微信刷新会生成新凭据文件，保留旧文件与已有 binding。二次验证码在交互终端隐藏输入；
脚本可结合 `--verification-code-file` 和 `--json` 使用。

企业微信发现可以读取尚未配置允许列表和 binding 的草稿账号，使用独立原生 socket，
只输出会话、用户和线程 ID，不向 Agent 转发正文。尚无账号时使用 `--bot-id` 配合
`--secret-env` 或 `--secret-file`。正常运行前，再将发现的用户加入允许列表并绑定会话。

## 媒体与可用性

Telegram、Discord、Slack、飞书、钉钉、QQ、Teams、WhatsApp、Matrix、Mattermost 和 Signal 支持原生图片、
音频、视频和文件，受平台限制。微信接收四类媒体，发送图片、视频和文件；LINE 接收
四类，发送图片、音频和视频；IRC 仅文本。企业微信 socket 发送四类媒体，webhook 的
被动最终回复发送图片。平台提供的语音识别文字会被保留。

Google Chat 接收原生附件；发送时使用公开 URL 的图片卡片和文件按钮，不上传原生附件。
部分富文本和媒体操作也需要外部平台能访问配置的 HTTPS 地址。Teams 个人文件可能需要
等待接收者授权。

各平台的消息格式和大小限制如下：

| 通道 | 呈现与发送前检查 |
| --- | --- |
| Telegram | MP4 动画作为视频接收；支持的 MP3、M4A 音频使用原生音频播放器。 |
| Discord | 图文回复使用 Components V2 的 Text Display 和 Media Gallery。图片描述截到 1,024 个 UTF-16 单元；图文图片单张最多 10 MiB、合计 20 MiB，普通上传最多 20 MiB。 |
| Slack | Markdown 转为结构化 `rich_text` 样式和链接，普通文本按渲染后 JSON 的 4,000 字节预算拆分。 |
| LINE | 图文通知预览最多保留 1,500 个 UTF-16 单元。 |
| Matrix | 图文回复的纯文本 fallback 各部分以空行分隔。 |
| Google Chat | 每个图文分块最多 20 部分、2,000 个 UTF-8 文本字节，保留稳定的原生请求 ID。 |

配置中更低的媒体限制仍然生效。公开媒体 URL 在票据有效期内复用，每次读取都会重新检查
当前会话授权。

WhatsApp 发送需要处于已记录入站消息后的 24 小时客户服务窗口内。QQ 群聊的被动回复
窗口按 5 分钟、C2C 按 1 小时处理；过期后省略 `msg_id`，尝试主动发送，仍受平台权限
和配额限制。

LINE 的 push 重试键会跨重启保留；首次尝试满 24 小时后停止重发，保留结果不明状态。
企业微信 webhook 的最终回复在平台取回前保持待处理状态。IRC 在 socket 写入成功后
确认发送，这不代表接收者已收到消息。

Agent 的 `relanox_status` 报告当前能力与发送可用性。本地协议测试覆盖消息格式、授权与
恢复，不代表真实账号已具备权限或完成兼容性验证。

## Discord 安装与线程

将 bot 安装到服务器，并在 Developer Portal → Bot → Privileged Gateway Intents
开启 **Message Content Intent**。符合条件或已验证的应用可能需要 Discord 审批。
Relanox 请求 `GUILD_MESSAGES`、`DIRECT_MESSAGES` 和 `MESSAGE_CONTENT`；内容权限也影响
附件和 REST 历史。参见官方 [Gateway 文档](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)。

接收及恢复需要 `VIEW_CHANNEL` 和 `READ_MESSAGE_HISTORY`，回复需要 `SEND_MESSAGES`，
媒体需要 `ATTACH_FILES`，链接及嵌入式媒体预览需要 `EMBED_LINKS`。线程还需要
`SEND_MESSAGES_IN_THREADS`，私有线程需要 bot 可见或已加入。binding 的 `chatId`
使用父频道 ID，`threadId` 使用原生线程频道 ID；普通频道省略 `threadId`，私聊使用
DM 频道 ID。Relanox 不会创建、加入或取消归档线程。参见官方[权限文档](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)。

## IRC 身份

频道绑定使用 `#room` 等原生频道名；私聊使用 `dm:<nick>`，昵称按服务器的 case mapping
折叠。发送者允许列表使用认证账号标签提供的 `account:<account>`。配置
`allowNickFallback: true` 后，没有认证账号标签的发送者也可以使用
`nick:<折叠后的昵称>`；裸昵称不能直接作为允许列表 ID。

## 恢复边界

Discord 首先尝试 Gateway 原生 resume；会话过期后，对每个已配置会话执行最多
20 页、每页 100 条的 REST 历史恢复。初次连接前会保存接收起点，新配置线程也有
独立起点。找不到旧锚点或超过历史范围时，连接保持 degraded / recovering，保留恢复状态。

Mattermost 持久化已接受的原生 WebSocket sequence 和 connection ID。原生队列无法
恢复时，每个已配置会话需要取得完整可见、少于 1,000 条的历史批次。历史缺失、满批
或请求失败都会保留旧 cursor 并保持 degraded。旧帖子的编辑、删除不会变成新入站消息；
新增会话绑定使用独立接收起点。

两个通道都提供高级账号选项 `recoveryEpoch`，正常运行时应省略。若旧历史已经无法取得，
运维人员可以用一个全新、非空的 epoch 并重启，放弃该段尚未接受的入站历史；这可能
跳过从未进入队列的消息。以后使用相同 epoch 重启不会再次重置，核心已接收的任务仍然
保留。Mattermost 接受 1–128 个 ASCII 字符，格式为 `[A-Za-z0-9][A-Za-z0-9._:-]*`；
Discord 最多 128 字节，不能包含空白或控制字符。每次恢复决策使用不同的值。

Matrix 的 limited timeline 从之前已接受的事件锚点恢复，最多回溯 20 页、每页 100 条。
找不到锚点时保留旧的全局 sync cursor，并报告 `sync_gap_unresolved`。

微信在整批消息接受成功后保存轮询 cursor。Signal 在事件处理成功后保存 SSE ID，重连时
发送 `Last-Event-ID`；能否重放早期事件取决于 daemon。这些检查点不代表每个原生通道
都能恢复完整历史。
