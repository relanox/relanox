# 企业微信智能机器人

在企业微信私聊和群聊中使用智能机器人。

## 准备账号

创建并启用可使用长连接的智能机器人，记录 Bot ID，将密钥保存到 `WECOM_BOT_SECRET`。向所需成员开放机器人，并将它加入目标群组。同一个机器人运行一个 Relanox 进程。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "wecom-main",
      "channel": "wecom",
      "allowedSenders": ["staff-userid"],
      "config": {
        "botId": "intelligent-robot-id",
        "secret": {
          "env": "WECOM_BOT_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "wecom-main",
      "chatId": "staff-userid",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

`allowedSenders` 填消息中的 `from.userid`。私聊绑定的 `chatId` 填成员 userid；群聊填回调的 `chatid`。从机器人经过认证的消息事件取得这些值，使用 ID 而非显示名称。

## 启用连接

启动 Relanox 后会自动连接 `wss://openws.work.weixin.qq.com`。保持进程运行。

## 发送第一条消息

向机器人私聊发送“你好”。在绑定群组中 @ 机器人提问，并确认你的企业成员 userid 已获允许。

## 图片和文件

可发送图片、视频、文件或图文混合消息；语音输入会将识别文字交给 Agent。媒体下载资源五分钟后过期，发送时保持 Relanox 在线。回复可包含 10 MiB 内的 PNG/JPEG/GIF 图片和 MP4 视频、2 MiB 内的 AMR 音频、20 MiB 内的文件，同时受 Relanox 限制。

## 常见问题

连接被替换时，停止使用同一机器人的其他进程，再重启本实例。群组提问没有响应时，检查机器人是否在群内并 @ 它。更换密钥后更新服务的环境变量，再重启服务。
