# LINE Messaging API

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "botUserId": "U_your_bot_destination",
  "channelSecret": {
    "env": "LINE_CHANNEL_SECRET"
  },
  "accessToken": {
    "env": "LINE_ACCESS_TOKEN"
  }
}
```

## 接入与身份

创建带 Messaging API 的 Official Account，获取 secret/access token，启用 `https://relay.example/channels/<accountId>/webhook`，可启用重投。Push 要求与用户为好友或加入群/聊天室，并具备权限和配额。`botUserId` 匹配 Webhook `destination`；白名单使用源 `userId`，绑定用户/群/聊天室 `chatId`，无线程地址。

## 投递与恢复

验证原始正文 HMAC-SHA256 `X-Line-Signature` 和 destination，持久接收后 ACK；`webhookEventId` 去重。独立 `/v2/bot/message/push` 每片最多 5,000 UTF-16 单元。发送前持久保存 UUID retry key，重试/恢复复用；409 且含 `X-Line-Accepted-Request-Id` 可确认此前接纳。首次尝试后 24 小时为本地重试期限，超时保留 unknown 需人工处理；接纳不证明收件人送达。429 重试，明确 4xx 拒绝。

## 参数与限制

`apiBase` 默认 `https://api.line.me`；`allowLoopback` 默认 false。不支持媒体、无法归属发送者的匿名事件、卡片、交互及 reply-token 发送。

## 账号变更

冻结机器人用户和规范化 API 地址，不保存凭据或 reply token。
