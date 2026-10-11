# LINE

连接 LINE 官方账号，回答私聊、群组和聊天室消息。

## 准备账号

创建具有 Messaging API Channel 的官方账号，将 Channel Secret 和 Access Token 存入下方环境变量。通过机器人信息或回调的 `destination` 取得机器人用户 ID。将官方账号添加为好友，或邀请到目标群组/聊天室，并检查套餐推送消息额度。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "line-main",
      "config": {
        "botUserId": "U_your_bot_destination",
        "channelSecret": {
          "env": "LINE_CHANNEL_SECRET"
        },
        "accessToken": {
          "env": "LINE_ACCESS_TOKEN"
        }
      },
      "channel": "line",
      "allowedSenders": ["U_example_user"]
    }
  ],
  "bindings": [
    {
      "accountId": "line-main",
      "chatId": "G_example_group",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

`allowedSenders` 填事件中的 `source.userId`。私聊 `chatId` 填该用户 ID，群组填 `source.groupId`，聊天室填 `source.roomId`。示例是群组绑定。`botUserId` 必须等于该账号回调的 `destination`。

## 启用连接

启用 Webhooks，将地址填为 `https://relay.example.com/channels/line-main/webhook`。启动 Relanox 后执行平台回调验证；需要 LINE 重试失败回调时，可启用 webhook redelivery。

## 发送第一条消息

用允许的用户向官方账号或绑定群组/聊天室发送“你好”。官方账号会将回复发到对应会话。

## 图片和文件

提问时可发送图片、音频、视频或文件。图片、音频和视频回复需配置 `publicUrl`，按[媒体](../media.md)通过 HTTPS 对外提供。使用 10 MB 内的 JPEG/PNG 图片。大于 1 MB（1,000,000 字节）的图片及每个 MP4 视频需提供不超过 1 MB 的 JPEG/PNG 预览图。生成音频使用 MP3/M4A 并带时长。音频/视频可到 200 MB，同时受 Relanox 限制。

## 常见问题

回调验证失败时，检查 Channel Secret 和机器人 destination ID。群消息缺失时，启用官方账号群组访问并确认它已加入。文字正常而媒体回复失败时，检查 HTTPS 媒体地址、预览图和时长；所有回复都需检查推送额度。
