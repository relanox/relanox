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

白名单和 `chatId` 绑定使用客户 `from` ID，无群/线程。GET 验证注册参数，POST 验证原始正文 `X-Hub-Signature-256`、企业和电话身份；源消息 ID 去重，状态通知及不支持的消息类型不建任务；接收文字与原生图片、音频、视频和文档。可信时间戳按 API/企业/电话/客户持久维护 24 小时客服窗口，新客户消息刷新；未来超过五分钟时间戳拒绝。延迟发送本地拒绝过期窗口，平台政策仍适用。独立 `POST /<apiVersion>/<phoneNumberId>/messages` 每片最多 4,096 UTF-16 单元，成功需平台消息 ID；429 重试，明确 4xx 拒绝。

## 参数与限制

`apiVersion` 必填，格式 `vN.N`；`apiBase` 默认 `https://graph.facebook.com`；`allowLoopback` 默认 false。支持客服自由文字和原生媒体，不支持模板、主动营销、贴纸及个人 WhatsApp/Web 接入。

## 账号变更

冻结电话号码 ID、Business Account ID 和规范化 API 地址；客户窗口同样按身份隔离，不复用无身份范围的旧窗口。

## 原生媒体

签名 Webhook 中的图片、音频、视频和文档按媒体 ID 读取。先请求 `GET /<apiVersion>/<mediaId>?phone_number_id=<配置电话>`，再带 bearer token 下载返回的短期 URL。凭证仅发送到配置 API origin 或 HTTPS lookaside.fbsbx.com；拒绝消息任意 URL、其他 origin 和重定向。保留说明文字与文档文件名，下载同时遵守核心和媒体类型大小上限。

输出先向 `POST /<apiVersion>/<phoneNumberId>/media` 上传包含 file/type/messaging_product 的 multipart，再以媒体 ID 发送原生 image/audio/video/document 消息。文档保留文件名。适配器允许 JPEG/PNG 图片最多 5,000,000 字节，AAC/AMR/MP3/MP4/OGG 音频和 MP4/3GPP 视频最多 16,000,000 字节，文本/PDF 和支持的 Microsoft Office 文档最多 100,000,000 字节；核心上限更低时仍受其限制。Meta 要求 OGG 为单声道 Opus、视频为 H.264/AAC，以及有效图片格式；Relanox 不转码或检查编码比特流。原生消息字段不支持 SDK 的独立预览或时长。

媒体也受 24 小时客服窗口限制。创建消息前的上传失败可安全重试；消息创建结果不明确时保留 unknown。媒体完整缓冲并持久保存，不支持流式传输。本地签名 HTTP、SQLite、MCP 和 multipart 测试验证字节收发，不证明真实账号兼容。

协议来源：[WhatsApp Business Platform 媒体](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media)。
