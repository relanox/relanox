# Telegram

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "botToken": {
    "env": "TELEGRAM_BOT_TOKEN"
  },
  "webhookSecret": {
    "env": "TELEGRAM_WEBHOOK_SECRET"
  }
}
```

## 接入与身份

创建机器人，在平台侧注册 `https://relay.example/channels/<accountId>/webhook`，配置相同 `secret_token` 和 `allowed_updates:["message"]`。Relanox 不会替换已有 Webhook。白名单使用十进制 `from.id`，绑定使用十进制聊天 ID，话题另设 `threadId`。匿名/频道帖子、机器人、编辑、服务消息不接收。

## 投递与恢复

恒定时间验证 Webhook 密钥；`update_id` 用于去重，持久接收后返回 HTTP 204，交接失败返回 503。独立调用 `sendMessage` 发送纯文字，关闭预览，保留原消息和话题引用，每片最多 4,096 个码点。同时检查 HTTP 状态和 API `ok`，429 按 `retry_after` 重试。

## 参数与限制

`apiBaseUrl` 默认 `https://api.telegram.org`，可指定受信 Bot API 服务/代理；`timeoutMs` 为 100–60,000，默认 10,000；`allowInsecureLoopback` 默认 false。令牌格式与 Webhook 密钥字符集在使用前校验。

## 原生媒体

接收图片、音频、语音、视频、动画、视频笔记和文档，通过 `getFile` 下载真实字节后持久入库。图片选取最大规格；说明文字作为请求文本，纯媒体也可创建任务。云端下载上限取 20 MiB 与中转限制的较小值。

生成媒体用 multipart `sendPhoto`、`sendAudio`/`sendVoice`、`sendVideo`、`sendDocument` 发送，并保留冻结聊天、话题及回复。GIF 图片使用 `sendAnimation`，音视频原生时长保留为毫秒并以整数秒发送。Ogg/Opus 使用 `sendVoice`。图片上传最多 10 MiB，其他媒体最多 50 MiB，同时受中转限制；平台继续检查格式、尺寸和账号限制。媒体说明最多 1,024 个码点；最终文本由核心另发文字片段，不会截断。不确定效果保持待处理。

参见[媒体传输](../media.md)及官方 [Bot API](https://core.telegram.org/bots/api#getfile)。本地测试验证 HTTP 和真实 multipart 字节，未验证真实账号或编码兼容性。

## 账号变更

冻结令牌数字前缀对应的机器人 ID 和规范化 API 地址。
