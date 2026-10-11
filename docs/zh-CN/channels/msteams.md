# Microsoft Teams Bot Connector

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "appId": "microsoft_application_id",
  "botId": "28:bot_activity_recipient_id",
  "tenantId": "allowed_teams_tenant_id",
  "appSecret": {
    "env": "TEAMS_APP_SECRET"
  },
  "trustedServiceOrigins": ["https://smba.trafficmanager.net"]
}
```

## 接入与身份

注册 Microsoft 应用/Azure Bot，启用 Teams，将 Teams 应用安装给目标用户/团队，配置 `https://relay.example/channels/<accountId>/activities`。输出需已安装会话和应用凭据。选择注册兼容的 tenant/token endpoint，包括单租户或主权云部署。`appId` 为 JWT audience/OAuth client，`botId` 为 Activity 收件人/发送者。

## 投递与恢复

白名单使用 `from.id`，绑定 `conversation.id` 和可选准确 `replyToId`。`trustedServiceOrigins` 为准确受信 origin，不含路径/末尾斜杠。RS256 验证 issuer/audience、时间、JWKS 签名、密钥的 msteams endorsement 和匹配 service URL claim；Activity 必须匹配渠道、机器人和租户。可信 origin 检查先于凭据发送，移除后在 OAuth/消息请求前拒绝。OAuth scope 为 `https://api.botframework.com/.default`，独立提交 `/v3/conversations/<id>/activities[/<parentId>]`，每片最多 12,000 UTF-16 单元。发消息前临时令牌失败可重试。

## 参数与限制

`issuer` 默认 `https://api.botframework.com`；`jwksUrl` 默认 `https://login.botframework.com/v1/.well-known/keys`；`tokenUrl` 默认 `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`；`allowLoopback` 默认 false。回环也要求 JWT，无模拟器/skills 绕过。不支持媒体、卡片、命令、创建会话、安装应用和编辑。

## 账号变更

冻结应用、机器人、租户及可信 service URL。恢复旧发送前也需恢复被移除的受信 origin。
