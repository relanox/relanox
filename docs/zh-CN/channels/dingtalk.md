# 钉钉应用机器人

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

```json
{
  "clientId": "application-client-id",
  "clientSecret": {
    "env": "DINGTALK_APP_SECRET"
  },
  "robotCode": "application-robot-code",
  "apiBase": "https://api.dingtalk.com",
  "maxReconnectAttempts": 20
}
```

## 接入与身份

启用应用机器人 Stream，配置匹配的 `robotCode`，授予独立单聊/群聊机器人消息 API 权限。应用必须可触达用户，机器人必须在目标群中。白名单使用可信回调的不透明 `senderId`，私聊绑定 `senderStaffId`，群聊绑定 `conversationId`（OpenAPI 的 `openConversationId`）。不支持缺少可用 staff ID 的外部身份。

## 投递与恢复

Stream 每次连接获取新 ticket，处理 ping/pong 并有上限地指数退避重连。忽略其他 robot code、自身消息及 `isInAtList` 不为 true 的群消息。`data.msgId` 去重，`headers.messageId` 关联 ACK；持久接收后才成功 ACK，媒体不作为文字任务接纳。独立输出调用 `/v1.0/robot/oToMessages/batchSend` 或 `/v1.0/robot/groupMessages/send`，使用 `sampleText`，令牌在内存刷新。每片最多 4,000 UTF-8 字节。`processQueryKey` 是查询句柄，不是消息 ID。流控/429 可重试，无效收件人和权限失败拒绝。

## 参数与限制

`apiBase` 默认 `https://api.dingtalk.com`；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。可信 API 地址会接收应用凭据，须限制配置修改权限。

## 账号变更

冻结 client ID、robot code 和规范化 API 地址，不保存 session webhook、ticket 或令牌。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
