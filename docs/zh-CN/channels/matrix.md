# Matrix

使用专用 Matrix 账号，在未加密房间和消息串中对话。

## 准备账号

在 Homeserver 创建专用账号/设备并取得 Access Token，保存到 `MATRIX_ACCESS_TOKEN`，记录完整用户 ID。邀请账号进入各房间并让其加入，授予发送消息和上传文件权限。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "matrix-main",
      "config": {
        "homeserver": "https://matrix.example.com",
        "userId": "@relay:example.com",
        "accessToken": {
          "env": "MATRIX_ACCESS_TOKEN"
        }
      },
      "channel": "matrix",
      "allowedSenders": ["@alice:example.com"]
    }
  ],
  "bindings": [
    {
      "accountId": "matrix-main",
      "chatId": "!support:example.com",
      "endpointId": "my-agent"
    }
  ]
}
```

允许发送者填写完整 Matrix 用户 ID，如 `@alice:example.com`。从房间信息或房间事件复制内部房间 ID（如 `!support:example.com`）填入 `chatId`。房间别名 `#support:example.com` 与房间 ID 不同。绑定消息串时，`threadId` 填原始 `m.thread` 根事件 ID。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

启动 Relanox 后会自动从 Homeserver 接收消息。保持配置的设备登录有效，并保持 Relanox 运行。使用 HTTPS Homeserver 地址。

## 发送第一条消息

用允许的账号在绑定的未加密房间发送“你好”。消息串绑定需在该串内回复。专用账号会将 Agent 回答发送到同一房间或消息串。

## 图片和文件

在房间消息中附加图片、音频、视频或文件。生成附件会上传到 Homeserver，以原生房间消息显示。附件需符合 Homeserver 上传限制和 Relanox 媒体限制。

## 常见问题

没有消息到达时，检查账号已加入房间、房间未加密、Token 仍有效。消息串没有回答时，核对根事件 ID。离线后报告历史缺口时，先检查遗漏会话，重新发送仍需回答的问题，再恢复连接。
