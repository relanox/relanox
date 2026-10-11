# WhatsApp Business Cloud API

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "phoneNumberId": "your_phone_number_id",
  "businessAccountId": "your_whatsapp_business_account_id",
  "apiVersion": "v25.0",
  "appSecret": {
    "env": "WHATSAPP_APP_SECRET"
  },
  "verifyToken": {
    "env": "WHATSAPP_VERIFY_TOKEN"
  },
  "accessToken": {
    "env": "WHATSAPP_ACCESS_TOKEN"
  }
}
```

## 接入与身份

创建 Meta 应用、注册企业电话号码，为 Business Account 订阅 messages Webhook，获取 `whatsapp_business_messaging` 和相应电话/企业权限。配置 `https://relay.example/channels/<accountId>/webhook` 与验证令牌，明确选择应用支持的 API 版本；示例版本不代表账号兼容承诺。

## 投递与恢复

白名单和 `chatId` 绑定使用客户 `from` ID，无群/线程。GET 验证注册参数，POST 验证原始正文 `X-Hub-Signature-256`、企业和电话身份；源消息 ID 去重，状态/非文字不建任务。可信时间戳按 API/企业/电话/客户持久维护 24 小时客服窗口，新客户消息刷新；未来超过五分钟时间戳拒绝。延迟发送本地拒绝过期窗口，平台政策仍适用。独立 `POST /<apiVersion>/<phoneNumberId>/messages` 每片最多 4,096 UTF-16 单元，成功需平台消息 ID；429 重试，明确 4xx 拒绝。

## 参数与限制

`apiVersion` 必填，格式 `vN.N`；`apiBase` 默认 `https://graph.facebook.com`；`allowLoopback` 默认 false。仅客服自由文字，不支持模板、主动营销、媒体及个人 WhatsApp/Web 接入。

## 账号变更

冻结电话号码 ID、Business Account ID 和规范化 API 地址；客户窗口同样按身份隔离，不复用无身份范围的旧窗口。
