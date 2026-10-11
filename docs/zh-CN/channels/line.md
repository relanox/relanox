# LINE Messaging API

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "botUserId": "U_your_bot_destination",
  "channelSecret": {
    "env": "LINE_CHANNEL_SECRET"
  },
  "accessToken": {
    "env": "LINE_ACCESS_TOKEN"
  }
}
```

## 接入与身份

创建带 Messaging API 的 Official Account，获取 secret/access token，启用 `https://relay.example/channels/<accountId>/webhook`，可启用重投。Push 要求与用户为好友或加入群/聊天室，并具备权限和配额。`botUserId` 匹配 Webhook `destination`；白名单使用源 `userId`，绑定用户/群/聊天室 `chatId`，无线程地址。

## 投递与恢复

验证原始正文 HMAC-SHA256 `X-Line-Signature` 和 destination，持久接收后 ACK；`webhookEventId` 去重。独立 `/v2/bot/message/push` 每片最多 5,000 UTF-16 单元。发送前持久保存 UUID retry key，重试/恢复复用；409 且含 `X-Line-Accepted-Request-Id` 可确认此前接纳。首次尝试后 24 小时为本地重试期限，超时保留 unknown 需人工处理；接纳不证明收件人送达。429 重试，明确 4xx 拒绝。

## 参数与限制

`apiBase` 默认 `https://api.line.me`；`allowLoopback` 默认 false。发送使用 push API，入站消息需要可识别的发送者。

## 原生媒体

图片、音频、视频、文件通过 `contentApiBase`（默认 `https://api-data.line.me`）认证下载；外部内容提供方的 URL 不携带 LINE 令牌。接收纯媒体及原生文字事件，确认前保存真实字节和音视频时长。

原生图片、音频、视频输出需要全局公开媒体发布配置，参见[媒体传输](../media.md)。LINE 通过不含代理凭据的随机公开 URL 获取字节。图片需 JPEG/PNG，最多 10 MB；预览图片最多 1 MB。小图片复用原图 URL，大图片及所有视频必须提供生成 previewUrl 或已有 previewMediaId。视频需 MP4，音频需 MP3/M4A 和正数 `durationMs`；音视频最多 200 MB，仍受中转限制。回复文字另发；push 沿用持久 retry key。

Messaging API 的[图片](https://developers.line.biz/en/reference/messaging-api/#image-message)、[音频](https://developers.line.biz/en/reference/messaging-api/#audio-message)和[视频](https://developers.line.biz/en/reference/messaging-api/#video-message)发送对象都要求 HTTPS `originalContentUrl`，图片和视频还要求 `previewImageUrl`。这些对象不提供二进制上传或可复用媒体 ID，因此媒体输出仍需 `media.publicBaseUrl`；文字输出和入站媒体下载不需要该发布配置。[Get content](https://developers.line.biz/en/reference/messaging-api/#get-content) 用于下载收到的消息，[图文菜单图片上传](https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image)只为图文菜单设置图片，不能为 push 消息提供媒体。

Messaging API 没有原生普通文件发送对象：可接收文件，拒绝文件输出，不声明该发送能力，也不将媒体替换成 URL 文字。可选 `contentApiBase` 支持管理员指定网关，遵循 `apiBase` 相同传输规则。

官方[消息对象](https://developers.line.biz/en/reference/messaging-api/index.html.md)定义平台限制。本地测试验证签名接收和原生 URL 字节下载，未验证真实账号播放、公开可达性及配额。

## 账号变更

冻结机器人用户和规范化 API 地址，不保存凭据或 reply token。
