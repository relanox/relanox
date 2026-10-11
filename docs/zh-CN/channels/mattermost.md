# Mattermost

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

```json
{
  "serverUrl": "https://mattermost.example.com",
  "botUserId": "dedicated_bot_user_id",
  "token": {
    "env": "MATTERMOST_TOKEN"
  }
}
```

## 接入与身份

创建专用机器人账号，授予目标频道读写权限。WebSocket 通过 token authentication_challenge 认证，接收 posted 事件。白名单为用户 ID，绑定频道 ID 和可选根帖子 ID threadId。解码 data.post，忽略自身帖子、空白和系统/非标准类型。

## 投递与恢复

稳定帖子 ID 去重，断线后重新认证，但没有历史重放，离线消息可能丢失。独立 `POST /api/v4/posts` 使用冻结 channel_id 和可选 root_id，成功要求帖子 ID。每片最多 16,000 个码点；429 可重试，明确 4xx 拒绝，传输/5xx/格式错误的成功响应保留 unknown。

## 参数与限制

`serverUrl`/`botUserId` 必填；`timeoutMs` 为 100–120,000，默认 10,000；`reconnectMs` 为 100–60,000，默认 1,000；`allowInsecureLocalhost` 默认 false。

## 账号变更

冻结服务器 URL 和配置的机器人用户 ID。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
