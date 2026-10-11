# QQ 机器人

通过官方 QQ 机器人，在私聊和 @ 机器人的群聊中使用 Agent。

## 准备账号

在 QQ 机器人平台创建并启用机器人，记录 App ID，将 Client Secret 存入环境变量，并获得 `GROUP_AND_C2C_EVENT` 权限。根据应用的测试或发布状态，向对应用户和群组开放机器人。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "qq-main",
      "channel": "qq",
      "allowedSenders": ["user-openid", "group-member-openid"],
      "config": {
        "appId": "123456789",
        "clientSecret": {
          "env": "QQ_CLIENT_SECRET"
        },
        "transport": "websocket",
        "apiBase": "https://api.bot.qq.com",
        "allowProactive": false,
        "maxReconnectAttempts": 20
      }
    }
  ],
  "bindings": [
    {
      "accountId": "qq-main",
      "chatId": "user-openid",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

私聊的允许发送者和绑定 `chatId` 均使用 `author.user_openid`。群聊允许发送者使用 `author.member_openid`，`chatId` 使用 `group_openid`。从机器人消息事件取得这些值；它们是平台 OpenID，与显示的 QQ 号码不同。

## 启用连接

Relanox 启动后会自动通过 WebSocket 连接，保持进程运行及访问 QQ API 和网关的出站网络。示例用于回复收到的消息，接入时保持 `allowProactive` 为 false。

## 发送第一条消息

私聊发送“你好”，或在绑定群组中 @ 机器人。先请它简短回复：平台为每条私聊输入提供 60 分钟、4 条回复额度，为每条群聊输入提供 5 分钟、5 条回复额度。

## 图片和文件

可发送原生图片、音频、视频和文件，生成的回复通过 QQ 附件发送。准备 PNG/JPEG 图片、MP4 视频、SILK 音频或普通文件。QQ 限制为图片/音频 20 MB、视频 30 MB、文件 200 MB；Relanox 默认 25 MiB 限制可能更低。回复文字与各个附件分别消耗回复额度。

## 常见问题

网关拒绝连接时，检查机器人发布状态、应用凭据及事件权限。群消息缺失时，@ 机器人并核对群组/成员 OpenID。回答延迟超过回复窗口时，发送新问题。取得平台主动消息权限且用户或群组允许接收后，才启用 `allowProactive:true`。
