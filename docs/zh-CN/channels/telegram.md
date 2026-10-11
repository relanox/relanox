# Telegram

通过 Telegram 机器人，在私聊、群组或话题中使用你的 Agent。

## 准备账号

在 @BotFather 创建机器人，将 Token 保存到 `TELEGRAM_BOT_TOKEN`。用字母、数字、`_` 和 `-` 生成回调密钥，保存到 `TELEGRAM_WEBHOOK_SECRET`。需要群聊时把机器人加入群组，并为 Relanox 准备公网 HTTPS 地址。

## 添加配置

注册 webhook 前，先向机器人私聊发送“你好”，在已设置 `TELEGRAM_BOT_TOKEN` 的 PowerShell 中执行下方命令。输出中的 `result[].message.from.id` 为用户 ID，`result[].message.chat.id` 为会话 ID。群组或话题 ID 也可通过在其中发送测试消息，再查看对应事件取得。此步骤适合新建机器人；已有机器人需先移除原 webhook 才能使用 `getUpdates`，请先与其维护者协调变更。

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates" |
  ConvertTo-Json -Depth 12
```

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "telegram-main",
      "channel": "telegram",
      "allowedSenders": ["123456789"],
      "config": {
        "botToken": {
          "env": "TELEGRAM_BOT_TOKEN"
        },
        "webhookSecret": {
          "env": "TELEGRAM_WEBHOOK_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "telegram-main",
      "chatId": "123456789",
      "endpointId": "my-agent"
    }
  ]
}
```

允许发送者填写消息中的十进制 `from.id`，会话绑定填写 `chat.id`，二者可从机器人收到的消息事件取得。私聊的会话 ID 通常等于你的用户 ID。群组 ID 可能为负数，保留负号。论坛话题还需将 `message_thread_id` 转为字符串填入绑定的 `threadId`。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

启动 Relanox 后，调用 Telegram Bot API 的 `setWebhook`：`url` 填 `https://relay.example.com/channels/telegram-main/webhook`，`secret_token` 填回调密钥，`allowed_updates` 填 `["message"]`。将域名换成自己的。可通过 `getWebhookInfo` 查看已登记地址及最近的回调错误。

## 发送第一条消息

打开机器人，点击开始，然后发送“你好”。在群组中 @ 机器人或回复它；如果希望接收普通群消息，在 BotFather 调整隐私设置。请在配置绑定的会话或话题中发送。

## 图片和文件

像平常一样发送图片、语音、音频、视频或文件，说明文字可写你的问题。接收的云端文件需符合 Telegram 的 20 MiB 下载限制及 Relanox 限制。回复可包含图片、音频、视频和文件；图片上传上限为 10 MiB，其他上传为 50 MiB，同时受 Relanox 限制。

## 常见问题

机器人收不到消息时，检查 `getWebhookInfo`、HTTPS 可达性及回调密钥是否一致。只有群消息缺失时，检查机器人是否在群内以及隐私设置。收到消息却没有回答时，核对发送者、会话和话题 ID。
