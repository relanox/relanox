# Slack

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

```json
{
  "receiveMode": "http",
  "botToken": {
    "env": "SLACK_BOT_TOKEN"
  },
  "signingSecret": {
    "env": "SLACK_SIGNING_SECRET"
  },
  "botUserId": "UBOT123",
  "teamId": "T123ABC",
  "appId": "A123ABC"
}
```

## 接入与身份

创建工作区应用，授予 `chat:write` 和目标会话需要的读取权限，订阅 `message.channels/groups/im/mpim` 或 `app_mention`。HTTP 地址为 `https://relay.example/channels/<accountId>/events`。Socket Mode 设置 `receiveMode:"socket"`，用 `appToken:{"env":"SLACK_APP_TOKEN"}` 替代 `signingSecret`，启用 Socket Mode 并授予应用令牌 `connections:write`。

## 投递与恢复

白名单使用用户 ID，绑定使用频道/线程 ID；根消息的 `ts` 作为回复线程，已有线程保留 `thread_ts`。忽略机器人、集成、编辑、subtype 和非文字事件。HTTP 验证原始正文 HMAC-SHA256、五分钟时效和应用/工作区身份。Socket Mode 持久接收后才 ACK，失败关闭连接且不 ACK；`event_id` 去重，重连重新获取连接地址。独立 `chat.postMessage` 转义 `&<>`，关闭 Markdown 解释和展开，每片最多 4,000 个码点。API `ok:false` 为错误，429 遵循 Retry-After。

## 参数与限制

`apiBaseUrl` 默认 `https://slack.com/api`；`timeoutMs` 为 100–60,000，默认 10,000；`reconnectDelayMs` 为 100–30,000，默认 1,000；`allowInsecureLoopback` 默认 false。不支持卡片、斜杠命令、交互载荷及临时消息。

## 账号变更

冻结工作区、应用、机器人用户及规范化 API 地址；不保存令牌或 Socket URL。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
