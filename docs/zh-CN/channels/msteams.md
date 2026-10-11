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

`issuer` 默认 `https://api.botframework.com`；`jwksUrl` 默认 `https://login.botframework.com/v1/.well-known/keys`；`tokenUrl` 默认 `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`；`allowLoopback` 默认 false。回环也要求 JWT，无模拟器/skills 绕过。

## 账号变更

冻结应用、机器人、租户及可信 service URL。恢复旧发送前也需恢复被移除的受信 origin。

## 媒体与原生文件同意

接收原生内联附件和私聊 `application/vnd.microsoft.teams.file.download.info` 文件，下载后持久接纳，支持纯媒体 Activity。内联凭据只发送到 `trustedServiceOrigins`，OneDrive 预授权下载不带机器人 Authorization。`mediaOrigins` 可额外配置私有下载 origin；下载限制 DNS 地址与字节、禁止跳转。应用清单需 `supportsFiles:true`。

不超过 15,000 字节的图片以 base64 data URL 原生附件发送；私聊中的更大图片以及音频、视频、文件走原生文件同意流程：持久 `application/vnd.microsoft.teams.card.file.consent`、认证 `fileConsent/invoke`、向同意后的 OneDrive URL PUT 原始字节、再发送 `application/vnd.microsoft.teams.card.file.info`。同意时检查冻结用户/会话/机器人；状态跨重启保留，等待不重复发卡。拒绝明确终止，同意卡发送状态不明需人工恢复。

私聊大图交付为 OneDrive 文件卡，而非内联图片预览，不需要 `media.publicBaseUrl`。应用清单必须启用 `supportsFiles:true`。

`trustedUploadOrigins` 配置租户 OneDrive 上传服务的准确 origin，默认空，未受信地址拒绝，上传不附带机器人凭据。原生文件同意仅支持 `personal` 私聊；群/频道音频、视频、文件发送以 `file_consent_requires_personal_chat` 明确拒绝，需要另行授权 Graph 流程，本适配器不隐式启用。说明文字独立发送。

协议依据：[Teams 文件与内联图片](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)。本地 JWT、HTTP、SQLite 测试不代表实账号兼容性已验证。

[媒体传输](../media.md)

群聊和频道中超过 15,000 字节的图片使用限定范围的公开 URL，避免 base64 消息包络过大，需要顶层 `media.publicBaseUrl`。Teams 文档中的机器人文件上传路径为私聊同意；全会话 Graph 文件交付需要额外的 OneDrive/SharePoint 授权，超出本适配器范围。等待同意会消耗投递尝试预算；预算耗尽后，迟到的同意需要明确重排投递。
