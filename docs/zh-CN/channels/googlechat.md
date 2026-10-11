# Google Chat HTTP 应用

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "audience": "https://relay.example/channels/chat/webhook",
  "callerEmail": "chat@system.gserviceaccount.com",
  "serviceAccount": {
    "env": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
  }
}
```

## 接入与身份

启用 Chat API，创建应用服务账号，将 JSON 凭据存入环境变量。配置普通 Chat 应用（非 Workspace add-on），HTTP audience 精确匹配 `https://relay.example/channels/<accountId>/webhook`。安装到目标空间并检查组织策略。输出使用 `chat.bot` 应用认证，不模拟人类或使用域级委派。

## 投递与恢复

白名单使用 `users/<id>`，绑定 `spaces/<id>` 和可选完整 `spaces/<id>/threads/<id>`。MESSAGE 优先使用 `argumentText` 去除应用 mention，忽略应用自身与无附件的空白内容；消息资源名去重。通过 JWKS 验证 RS256 OIDC 签名、issuer、准确 audience、时间和已验证调用者邮箱，不信任 JSON 声称的调用者。服务账号 JWT 交换 OAuth，独立 `/v1/spaces/<id>/messages` 对线程使用 `REPLY_MESSAGE_OR_FAIL`。每片最多 30,000 UTF-8 字节；发消息前临时 OAuth 失败可重试。

## 参数与限制

`callerEmail` 默认 `chat@system.gserviceaccount.com`；`issuer` 默认 `https://accounts.google.com`；`jwksUrl` 默认 `https://www.googleapis.com/oauth2/v3/certs`；`tokenUrl` 默认 `https://oauth2.googleapis.com/token`；`apiBase` 默认 `https://chat.googleapis.com`；`allowLoopback` 默认 false。覆盖地址由管理员信任，不能由事件指定。不支持 add-on 封装、Pub/Sub/Workspace Events、项目编号 JWT 模式、入站卡片、斜杠命令、编辑及成员操作。

## 账号变更

冻结服务账号 client email 和规范化 API 地址，不保存私钥。

## 媒体与应用身份

原生上传附件通过 `attachmentDataRef.resourceName` 和 `/v1/media/<resource>?alt=media` 下载，使用服务账号 `chat.bot` 认证；资源必须属于事件空间，纯媒体作为持久任务。Drive 引用需要额外 Drive 授权，当前明确拒绝，不静默丢弃。下载限制 DNS 地址与字节，凭据只发送到配置 API origin，禁止跳转。

输出要求顶层 `media.publicBaseUrl`。保持机器人身份，图片以原生 `cardsV2` 图片组件和具名下载按钮发送；音频、视频、普通文件以具名下载按钮发送。后者是**链接降级**，不是上传的原生附件。保留冻结机器人/空间/线程身份与 `REPLY_MESSAGE_OR_FAIL`，说明文字独立发送。发送能力声明表示接受这些媒体并按上述卡片/链接方式交付。

Google 原生附件上传要求用户 OAuth（`chat.messages.create`/`chat.messages`），不接受 `chat.bot`。Relanox 不隐式模拟用户或启用域级委派。协议依据：[下载](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download)、[上传认证限制](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/upload)。本地 JWT、HTTP、SQLite 测试不代表实账号兼容性已验证。

[媒体传输](../media.md)
