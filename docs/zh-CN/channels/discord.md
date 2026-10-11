# Discord

账号 `config`（[配置说明](../configuration.md)）：

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

READY 必须匹配 `botUserId`。原生处理心跳/ACK、Identify/Resume 和重连；致命认证、intents 或分片关闭码停止重连。账号会话/序号持久保存，接收成功才推进游标，失败保留旧游标；平台会话过期仍限制重放。接收人类普通/回复文字及附件，忽略机器人、Webhook 和系统消息。发送引用原消息并禁止 mention，每片最多 2,000 UTF-16 单元。稳定 nonce 和 `enforce_nonce` 仅在数分钟内减少重复；429 按 `retry_after` 重试。

## 参数与限制

`apiBaseUrl` 默认 `https://discord.com/api/v10`；`gatewayUrl` 默认 `wss://gateway.discord.gg`；`timeoutMs` 为 100–60,000，默认 10,000；`reconnectDelayMs` 为 100–30,000，默认 5,000；`allowInsecureLoopback` 默认 false。不支持交互、编辑、语音连接、分片及同一机器人并发会话。

## 原生媒体

Gateway 接收纯附件及文字附带附件。`MESSAGE_CONTENT` 同时决定文字和附件字段可见性；发送还需 `ATTACH_FILES` 权限。通过有界 HTTPS CDN 下载附件，不携带机器人令牌；持久保存真实字节。

图片、音频、视频及文件通过 Create Message multipart `payload_json`/`files[0]` 上传，保留冻结频道或线程、原消息引用、mention 抑制及 nonce。上传采用保守的 10 MiB 上限，同时受中转限制；服务器等级、编码和平台限制仍生效。不确定媒体发送不自动重放。

参见[媒体传输](../media.md)及官方[消息 API](https://docs.discord.com/developers/resources/message#create-message)。本地 Gateway/REST 测试验证字节传输，未验证真实账号权限及播放。

## 账号变更

冻结机器人用户和规范化 API 地址；保存的 Gateway 会话还匹配 Gateway URL，身份/服务器变化后重新 Identify。
