# WhatsApp Business

通过 WhatsApp Business Cloud API 号码回答客户消息。

## 准备账号

创建具有 WhatsApp Business Platform 权限的 Meta 应用，注册企业电话号码。记录电话号码 ID 和 Business Account ID。取得具备 `whatsapp_business_messaging` 且可访问该号码/企业的 Access Token。保存应用密钥，并选择回调验证 Token。Relanox 使用 Graph API `v25.0`，支持的 API 版本由 Relanox 版本统一管理。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "whatsapp-main",
      "config": {
        "phoneNumberId": "your_phone_number_id",
        "businessAccountId": "your_whatsapp_business_account_id",
        "appSecret": {
          "env": "WHATSAPP_APP_SECRET"
        },
        "verifyToken": {
          "env": "WHATSAPP_VERIFY_TOKEN"
        },
        "accessToken": {
          "env": "WHATSAPP_ACCESS_TOKEN"
        }
      },
      "channel": "whatsapp",
      "allowedSenders": ["15551234567"]
    }
  ],
  "bindings": [
    {
      "accountId": "whatsapp-main",
      "chatId": "15551234567",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

将收到消息的 `from` 值同时填入 `allowedSenders` 和 `chatId`，如 `15551234567`，按企业消息事件原样复制数字。`phoneNumberId` 填平台电话号码 ID，而非显示的电话号码。

## 启用连接

启动 Relanox，在 WhatsApp 回调配置中填写 `https://relay.example.com/channels/whatsapp-main/webhook`，验证 Token 使用 `WHATSAPP_VERIFY_TOKEN` 的值。将应用订阅到 Business Account 的 `messages` 事件。

## 发送第一条消息

由允许的客户号码向企业号码发送“你好”。客户消息会开启 24 小时服务窗口，供文字和媒体回复使用。延迟回答遇到窗口过期时，再发送一条新消息。

## 图片和文件

可发送图片、音频、视频或文档，在可用时附带说明文字。回复可包含 5 MB 内 JPEG/PNG 图片、16 MB 内受支持音频和 MP4/3GPP 视频，以及 100 MB 内文本/PDF/Office 文档，同时受 Relanox 限制。使用对应格式时，准备单声道 Opus OGG 音频和 H.264/AAC 视频。

## 常见问题

回调验证失败时，逐字核对验证 Token。消息缺失时，检查 `messages` 订阅、Business Account ID 和电话号码 ID。发送错误时，检查 Token 权限、应用 API 版本，以及客户是否在过去 24 小时内发送过消息。
