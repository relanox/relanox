# 钉钉应用机器人

账号 `config`（[配置说明](../configuration.md)）：

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

Stream 每次连接获取新 ticket，处理 ping/pong 并有上限地指数退避重连。忽略其他 robot code、自身消息及 `isInAtList` 不为 true 的群消息。`data.msgId` 去重，`headers.messageId` 关联 ACK；持久接收后才成功 ACK，支持的媒体作为附件持久接纳。独立输出调用 `/v1.0/robot/oToMessages/batchSend` 或 `/v1.0/robot/groupMessages/send`，文字使用 `sampleText`，媒体使用下述原生模板，令牌在内存刷新。每片最多 4,000 UTF-8 字节。`processQueryKey` 是查询句柄，不是消息 ID。流控/429 可重试，无效收件人和权限失败拒绝。

## 参数与限制

`apiBase` 默认 `https://api.dingtalk.com`；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。可信 API 地址会接收应用凭据，须限制配置修改权限。

## 账号变更

冻结 client ID、robot code 和规范化 API 地址，不保存 session webhook、ticket 或令牌。

## 媒体

Stream 图片、语音、视频、文件及富文本通过 `downloadCode` 或 `pictureDownloadCode` 获取资源。调用 `/v1.0/robot/messageFiles/download` 获得临时 URL，有上限地下载并持久接收字节后才成功 ACK。支持纯媒体，保留语音转写与富文本说明。

向 `uploadBase`（默认 `https://oapi.dingtalk.com`）提交 multipart `media`，再向冻结单聊/群聊发送 `sampleImageMsg`、`sampleAudio`、`sampleVideo` 或 `sampleFile`。JPEG/PNG/GIF/BMP 图片、MP4 视频和文件最多 20 MiB，AMR 语音最多 2 MiB；文件模板支持 XLSX/PDF/ZIP/RAR/DOC/DOCX。语音要求 `durationMs`，视频还需同一请求内图片 `previewMediaId`，不编造时长或封面。缺失元数据、不支持格式与超限明确拒绝，说明文字独立发送。

`mediaOrigins` 可配置私有下载服务准确受信 origin。下载限制 DNS 地址与字节、禁止跳转；回环 HTTP 还需准确媒体 origin 和 `allowInsecureLoopback:true`。媒体目标同时冻结 uploadBase，凭据不进入目标。

协议依据：[上传媒体](https://open.dingtalk.com/document/development/upload-media-files)、[机器人下载](https://open.dingtalk.com/document/development/download-the-file-content-of-the-robot-receiving-message)。本地 HTTP、socket、SQLite 测试不代表实账号兼容性已验证。

[媒体传输](../media.md)
