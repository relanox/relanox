# Microsoft Teams

通过安装的 Teams 机器人，在个人聊天、群聊或频道中使用 Agent。

## 准备账号

注册 Microsoft 应用和 Azure Bot，启用 Teams 渠道，并向所需用户或团队安装 Teams 应用。记录应用 ID、机器人 Activity ID 和租户 ID，将应用密钥保存到 `TEAMS_APP_SECRET`。请管理员确认所在区域的 Bot Connector 服务可信来源。单租户机器人将 `tokenUrl` 设为 `https://login.microsoftonline.com/<应用租户ID>/oauth2/v2.0/token`。应用租户可以与 `tenantId` 中允许接入的 Teams 租户不同。此渠道使用公有云 Bot Framework 认证。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "msteams-main",
      "config": {
        "appId": "microsoft_application_id",
        "botId": "28:bot_activity_recipient_id",
        "tenantId": "allowed_teams_tenant_id",
        "appSecret": {
          "env": "TEAMS_APP_SECRET"
        },
        "trustedServiceOrigins": ["https://smba.trafficmanager.net"]
      },
      "channel": "msteams",
      "allowedSenders": ["29:teams-user-id"]
    }
  ],
  "bindings": [
    {
      "accountId": "msteams-main",
      "chatId": "teams-conversation-id",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

从 Teams 消息 Activity 取得 ID：`from.id` 为允许发送者，`conversation.id` 为绑定会话 ID，`recipient.id` 为配置的机器人 ID。`tenantId` 填 Activity 对应租户 ID。绑定回复链时，使用其中的 `replyToId` 作为 `threadId`。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

将机器人消息端点设为 `https://relay.example.com/channels/msteams-main/activities`，然后启动 Relanox。`trustedServiceOrigins` 填完整 HTTPS 来源，如 `https://smba.trafficmanager.net`，不带路径或尾斜杠；使用你所在部署的值。

## 发送第一条消息

打开已安装机器人的个人聊天，发送“你好”。群聊或频道绑定需加入机器人并在该会话 @ 它。使用配置中的租户和用户。

## 图片和文件

提问时可发送内嵌图片或个人聊天文件。个人聊天文件回复需在 Teams 应用清单设置 `supportsFiles:true`，并配置租户 OneDrive 上传服务的精确 `trustedUploadOrigins`。机器人请求文件授权时，接受后即可收到文件。个人聊天中超过 15,000 字节的图片也以文件卡片送达。群聊/频道中超过该大小的图片回复使用[媒体](../media.md)中的公网媒体地址。

## 常见问题

认证失败时，核对应用、机器人和租户 ID，以及注册方式所需的 OAuth Token 地址。服务来源错误时，请管理员核实 Activity 的服务来源后再添加。文件等待发送时，打开个人聊天中的授权卡片；上传被拒绝时，检查 `trustedUploadOrigins` 和应用文件设置。
