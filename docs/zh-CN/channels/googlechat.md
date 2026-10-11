# Google Chat HTTP 应用

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

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

白名单使用 `users/<id>`，绑定 `spaces/<id>` 和可选完整 `spaces/<id>/threads/<id>`。MESSAGE 优先使用 `argumentText` 去除应用 mention，忽略应用自身和空白/纯媒体；消息资源名去重。通过 JWKS 验证 RS256 OIDC 签名、issuer、准确 audience、时间和已验证调用者邮箱，不信任 JSON 声称的调用者。服务账号 JWT 交换 OAuth，独立 `/v1/spaces/<id>/messages` 对线程使用 `REPLY_MESSAGE_OR_FAIL`。每片最多 30,000 UTF-8 字节；发消息前临时 OAuth 失败可重试。

## 参数与限制

`callerEmail` 默认 `chat@system.gserviceaccount.com`；`issuer` 默认 `https://accounts.google.com`；`jwksUrl` 默认 `https://www.googleapis.com/oauth2/v3/certs`；`tokenUrl` 默认 `https://oauth2.googleapis.com/token`；`apiBase` 默认 `https://chat.googleapis.com`；`allowLoopback` 默认 false。覆盖地址由管理员信任，不能由事件指定。不支持 add-on 封装、Pub/Sub/Workspace Events、项目编号 JWT 模式、卡片、斜杠命令、编辑、成员操作及附件。

## 账号变更

冻结服务账号 client email 和规范化 API 地址，不保存私钥。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
