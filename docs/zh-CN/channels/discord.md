# Discord

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

```json
{
  "botToken": {
    "env": "DISCORD_BOT_TOKEN"
  },
  "botUserId": "987654321098765432"
}
```

## 接入与身份

启用 Message Content intent，授予机器人查看/发送频道消息及访问线程权限。默认 intents 为 37377（`GUILDS`、`GUILD_MESSAGES`、`DIRECT_MESSAGES`、`MESSAGE_CONTENT`），自定义值必须保留三个消息/内容位。Gateway v10 JSON/WSS 接收，REST v10 发送。白名单使用用户 ID；普通频道和私聊绑定频道 ID，服务器线程绑定父频道 `chatId` 和线程频道 `threadId`。

## 投递与恢复

READY 必须匹配 `botUserId`。原生处理心跳/ACK、Identify/Resume 和重连；致命认证、intents 或分片关闭码停止重连。账号会话/序号持久保存，接收成功才推进游标，失败保留旧游标；平台会话过期仍限制重放。接收人类普通/回复文字，忽略机器人、Webhook、系统消息和非文字。发送引用原消息并禁止 mention，每片最多 2,000 UTF-16 单元。稳定 nonce 和 `enforce_nonce` 仅在数分钟内减少重复；429 按 `retry_after` 重试。

## 参数与限制

`apiBaseUrl` 默认 `https://discord.com/api/v10`；`gatewayUrl` 默认 `wss://gateway.discord.gg`；`timeoutMs` 为 100–60,000，默认 10,000；`reconnectDelayMs` 为 100–30,000，默认 5,000；`allowInsecureLoopback` 默认 false。不支持媒体、交互、编辑、语音、分片及同一机器人并发会话。

## 账号变更

冻结机器人用户和规范化 API 地址；保存的 Gateway 会话还匹配 Gateway URL，身份/服务器变化后重新 Identify。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
