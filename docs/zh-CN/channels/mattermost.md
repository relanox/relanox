# Mattermost

在你的 Mattermost 服务器，通过专用机器人使用频道和消息串。

## 准备账号

创建机器人账号和 Access Token，将 Token 保存到 `MATTERMOST_TOKEN`；Relanox 启动时会自动查询机器人用户 ID。把机器人加入目标频道并授予读取和发帖权限。附件还需 `upload_file` 和 `read_channel` 权限。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "mattermost-main",
      "config": {
        "serverUrl": "https://mattermost.example.com",
        "token": {
          "env": "MATTERMOST_TOKEN"
        }
      },
      "channel": "mattermost",
      "allowedSenders": ["dedicated_sender_id"]
    }
  ],
  "bindings": [
    {
      "accountId": "mattermost-main",
      "chatId": "dedicated_channel_id",
      "endpointId": "my-agent"
    }
  ]
}
```

`allowedSenders` 填 Mattermost 用户 ID，`chatId` 填频道 ID。机器人 Token 可调用 `GET /api/v4/users/username/<username>` 取得发送者 ID，`GET /api/v4/teams/name/<team>/channels/name/<channel>` 取得频道 ID；消息事件也包含 `user_id` 和 `channel_id`。指定消息串时，`threadId` 填根帖 ID。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

`serverUrl` 填 Mattermost 服务器的 HTTPS 基础地址。启动 Relanox 后会自动打开服务器 WebSocket 连接。确保反向代理允许 WebSocket，并保持进程运行。

## 发送第一条消息

用允许的用户在绑定频道发送“你好”。消息串绑定需在根帖下回复。机器人将回答发到同一频道或消息串。

## 图片和文件

像平常一样附加图片、音频、视频或文件。生成文件以原生帖子附件发回，Mattermost 会生成可用预览。文件需符合服务器上传大小设置和 Relanox 媒体限制。

## 常见问题

连接失败时，核对 HTTPS 服务器地址、Token 和代理 WebSocket 设置。帖子缺失时，检查频道成员资格与 ID。Relanox 断线期间发送的问题，在恢复连接后重新发送。上传失败时，检查机器人权限和服务器文件大小设置。
