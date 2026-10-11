# Telegram

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

```json
{
  "botToken": {
    "env": "TELEGRAM_BOT_TOKEN"
  },
  "webhookSecret": {
    "env": "TELEGRAM_WEBHOOK_SECRET"
  }
}
```

## 接入与身份

创建机器人，在平台侧注册 `https://relay.example/channels/<accountId>/webhook`，配置相同 `secret_token` 和 `allowed_updates:["message"]`。Relanox 不会替换已有 Webhook。白名单使用十进制 `from.id`，绑定使用十进制聊天 ID，话题另设 `threadId`。匿名/频道帖子、机器人、编辑、服务消息和媒体不接收。

## 投递与恢复

恒定时间验证 Webhook 密钥；`update_id` 用于去重，持久接收后返回 HTTP 204，交接失败返回 503。独立调用 `sendMessage` 发送纯文字，关闭预览，保留原消息和话题引用，每片最多 4,096 个码点。同时检查 HTTP 状态和 API `ok`，429 按 `retry_after` 重试。

## 参数与限制

`apiBaseUrl` 默认 `https://api.telegram.org`，可指定受信 Bot API 服务/代理；`timeoutMs` 为 100–60,000，默认 10,000；`allowInsecureLoopback` 默认 false。令牌格式与 Webhook 密钥字符集在使用前校验。

## 账号变更

冻结令牌数字前缀对应的机器人 ID 和规范化 API 地址。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
