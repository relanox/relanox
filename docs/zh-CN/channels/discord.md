# Discord

在 Discord 私聊、服务器频道和帖子中使用机器人。

## 准备账号

在 Discord 开发者门户创建应用和机器人，将 Token 保存到 `DISCORD_BOT_TOKEN`，机器人用户 ID 填入 `botUserId`。启用 Message Content Intent，邀请机器人时授予查看频道、发送消息、访问所需帖子及附加文件权限。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "discord-main",
      "channel": "discord",
      "allowedSenders": ["123456789012345678"],
      "config": {
        "botToken": {
          "env": "DISCORD_BOT_TOKEN"
        },
        "botUserId": "987654321098765432"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "discord-main",
      "chatId": "112233445566778899",
      "endpointId": "my-agent"
    }
  ]
}
```

在 Discord 启用开发者模式，再复制发送者和频道 ID。`allowedSenders` 填用户 ID。普通频道绑定填写频道 ID；帖子绑定的 `chatId` 填父频道 ID，`threadId` 填帖子频道 ID。私聊使用私聊频道 ID。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

添加账号后启动 Relanox，它会自动连接 Discord。保持进程运行，并允许访问 Discord 的出站 HTTPS 和 WebSocket 连接。

## 发送第一条消息

用允许的用户在绑定频道或私聊中发送“你好”。帖子绑定需先进入该帖子，回复会出现在同一会话中。

## 图片和文件

可在消息中附加图片、音频、视频或文件，也可单独发送附件。机器人会通过 Discord 发回生成的附件。文件需同时符合 Relanox 媒体限制和服务器的 Discord 上传额度。

## 常见问题

消息正文缺失时，检查 Message Content Intent 和频道权限。帖子没有回复时，检查父频道与帖子 ID，以及帖子访问权限。机器人连接失败时，确认 Token 属于配置中的机器人用户。
