# Slack

账号 `config`（[配置说明](../configuration.md)）：

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

白名单使用用户 ID，绑定使用频道/线程 ID；根消息的 `ts` 作为回复线程，已有线程保留 `thread_ts`。忽略机器人、集成、编辑及不支持的 subtype 事件。HTTP 验证原始正文 HMAC-SHA256、五分钟时效和应用/工作区身份。Socket Mode 持久接收后才 ACK，失败关闭连接且不 ACK；`event_id` 去重，重连重新获取连接地址。独立 `chat.postMessage` 转义 `&<>`，关闭 Markdown 解释和展开，每片最多 4,000 个码点。API `ok:false` 为错误，429 遵循 Retry-After。

## 参数与限制

`apiBaseUrl` 默认 `https://slack.com/api`；`timeoutMs` 为 100–60,000，默认 10,000；`reconnectDelayMs` 为 100–30,000，默认 1,000；`allowInsecureLoopback` 默认 false。不支持卡片、斜杠命令、交互载荷及临时消息。

## 原生媒体

增加机器人 `files:read`、`files:write` 权限。普通消息、`app_mention` 和 `file_share` 接收纯文件或文字加附件；缺少下载 URL 时调用 `files.info`。私有下载仅向 `https://files.slack.com` 或配置的 API origin 携带令牌，拒绝重定向及其他凭据目标。

图片、音频、视频及文件按 `files.getUploadURLExternal`、真实字节上传、`files.completeUploadExternal` 流程发送，保留冻结频道及 `thread_ts`。回复文字另发纯文字片段。上传受中转限制及工作区权限、配额约束；上传成功不等于已分享到会话，不确定的完成效果保留待处理。

参见[媒体传输](../media.md)和官方[文件工作流](https://docs.slack.dev/messaging/working-with-files/)。本地测试验证签名入口、字节上传及完成请求，未验证真实工作区权限。

## 账号变更

冻结工作区、应用、机器人用户及规范化 API 地址；不保存令牌或 Socket URL。
