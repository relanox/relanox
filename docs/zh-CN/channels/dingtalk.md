# 钉钉应用机器人

通过钉钉应用机器人进行私聊提问和群聊对话。

## 准备账号

创建应用机器人，记录 Client ID 和 Robot Code，将应用密钥保存到 `DINGTALK_APP_SECRET`。启用 Stream 接收方式，授予机器人单聊/群聊独立发送消息及媒体下载/上传权限。将它加入目标群组，并开放给所需员工。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "dingtalk-main",
      "channel": "dingtalk",
      "allowedSenders": ["$:LWCP_v1:opaque-platform-sender-id"],
      "config": {
        "clientId": "application-client-id",
        "clientSecret": {
          "env": "DINGTALK_APP_SECRET"
        },
        "robotCode": "application-robot-code",
        "apiBase": "https://api.dingtalk.com"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "dingtalk-main",
      "chatId": "staff-user-id",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

允许发送者使用回调中的不透明 `senderId`，包括前缀。私聊 `chatId` 使用 `senderStaffId`，群聊使用 `conversationId`（开放会话 ID）。从应用机器人的消息事件取得这些值。发送者 ID 和私聊 ID 用途不同，请分别复制对应字段。

## 启用连接

保存账号配置后启动 Relanox。它会使用应用凭据自动建立 Stream 连接，请保持出站 HTTPS 和 WebSocket 可用。

## 发送第一条消息

由允许的员工向应用机器人发送“你好”。群聊中请 @ 机器人，让群消息事件包含对机器人的提及。

## 图片和文件

可发送图片、音频、视频、文件或富文本消息。回复可包含 20 MiB 内的 JPEG/PNG/GIF/BMP 图片、MP4 视频和文件，以及 2 MiB 内的 AMR 音频，同时受 Relanox 限制。生成音频需带时长；视频还需图片预览和时长。文件回复使用 XLSX、PDF、ZIP、RAR、DOC 或 DOCX 格式。

## 常见问题

机器人已连接但没有回复时，检查独立发送消息 API 权限和员工/群组可用范围。私聊被过滤时，分别核对允许列表的 `senderId` 与绑定的 `senderStaffId`。群组失败时，检查 Robot Code 和机器人是否在群内。
