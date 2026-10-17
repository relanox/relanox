# Microsoft Teams

通过安装的 Teams 机器人，在个人聊天、群聊或频道中使用 Agent。

## 准备账号

注册 Microsoft 应用和 Azure Bot，启用 Teams 渠道，并向所需用户或团队安装 Teams 应用。记录应用 ID、机器人 Activity ID、机器人应用租户 ID 和允许接入的 Teams Activity 租户 ID，将应用密钥保存到 `TEAMS_APP_SECRET`。请管理员确认所在区域的 Bot Connector 服务可信来源。单租户机器人的 OAuth Token 地址使用 `https://login.microsoftonline.com/<应用租户ID>/oauth2/v2.0/token`。应用租户可以与允许接入的 Teams 租户不同。现有多租户机器人可填写其注册所用的 Token 地址；[Microsoft 文档列出了两种认证地址](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0)。此渠道使用公有云 Bot Framework 认证。

连接通过 Microsoft 官方 Teams SDK 使用公有云 Bot Connector 认证。`tokenUrl` 必须是标准 Entra v2 Token 端点 `https://login.microsoftonline.com/<应用租户ID>/oauth2/v2.0/token`，其中租户属于应用注册，可以与允许接入的 Teams `tenantId` 不同。默认值使用旧版 `botframework.com` 授权域，不支持自定义 Token 路径或查询参数。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **Microsoft Teams**，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段                  | 填写内容                            |
| --------------------------- | ----------------------------------- |
| 应用 ID                     | 上一步取得的应用 ID                 |
| 机器人 ID                   | 上一步取得的机器人 ID               |
| 允许接入的 Teams 租户 ID    | Teams Activity 中允许接入的租户 ID  |
| 机器人应用 OAuth Token 地址 | 机器人应用注册方式对应的 Token 地址 |
| 可信服务源（逗号分隔）      | 上一步取得的可信服务源（逗号分隔）  |

将下载的配置保存为 `relanox.json`，并按接入教程在服务器上设置密钥。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#msteams)。

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

从 Teams 消息 Activity 取得 ID：`from.id` 为允许发送者，`conversation.id` 为绑定会话 ID，`recipient.id` 为配置的机器人 ID。「允许接入的 Teams 租户 ID」填 Activity 对应租户 ID；OAuth Token 地址使用机器人应用注册所在的租户。绑定回复链时，使用其中的 `replyToId` 作为「话题 / 线程 ID」。

## 启用连接

将机器人消息端点设为 `https://relay.example.com/channels/msteams-main/activities`，然后启动 Relanox。`trustedServiceOrigins` 填完整 HTTPS 来源，如 `https://smba.trafficmanager.net`，不带路径或尾斜杠；使用你所在部署的值。

SDK 使用 Relanox 已有的 HTTP 监听服务。成功响应会等待 Core 接收消息或持久化文件授权状态。SDK 管理 OAuth Token 缓存与限流，消息投递重试仍由 Core 处理；不启用流式回复，也不增加用户或 Graph 授权。

向已绑定会话发送还需要 Bot Connector 服务地址和会话元数据。Relanox 从已验证的 `message`、`conversationUpdate` 或 `installationUpdate` Activity 保存这些信息，要求发送者已获允许，且机器人和租户与账号匹配。因此，安装或会话事件可以在第一条消息之前建立可用目标。仅有聊天 ID 不足以发送；服务地址还必须通过 `trustedServiceOrigins` 校验。

## 发送第一条消息

打开已安装机器人的个人聊天，发送“你好”。群聊或频道绑定需加入机器人并在该会话 @ 它。使用配置中的租户和用户。

Agent 指定 `reply.requestId` 时，答案会通过 Teams 原生引用回复关联该条来信。答案仍在绑定的消息串内；回复会话根层级的来信时，使用所选消息的回复链。文本、卡片和附件使用同一引用。不传 `reply` 时省略引用，在绑定的会话或消息串中普通发送。

## 图片和文件

提问时可发送内嵌图片或个人聊天文件。个人聊天文件回复需在 Teams 应用清单设置 `supportsFiles:true`，并配置租户 OneDrive 上传服务的精确 `trustedUploadOrigins`。机器人请求文件授权时，接受后即可收到文件。个人聊天中超过 15,000 字节的图片也以文件卡片送达。群聊/频道中超过该大小的图片回复使用[媒体](../media.md)中的公网媒体地址。

Core 默认单文件预算为 100 MiB，平台仍可能按自身规则拒绝更小的文件。个人文件通过 10 MiB 的顺序分片上传，预授权上传 URL 不携带 Bearer 凭据。文件授权状态和已完成的分片位置在重启后保留，不额外申请 Graph 权限。这些协议路径经过本地 HTTP 与 SQLite 测试，不代表已经验证真实租户兼容性。参阅 [Teams 文件支持](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)和 [OneDrive 上传会话](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)。

## 常见问题

认证失败时，核对应用、机器人和租户 ID，以及注册方式所需的 OAuth Token 地址。服务来源错误时，请管理员核实 Activity 的服务来源后再添加。文件等待发送时，打开个人聊天中的授权卡片；上传被拒绝时，检查 `trustedUploadOrigins` 和应用文件设置。
