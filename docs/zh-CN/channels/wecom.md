# 企业微信智能机器人

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "botId": "intelligent-robot-id",
  "secret": {
    "env": "WECOM_BOT_SECRET"
  },
  "wsUrl": "wss://openws.work.weixin.qq.com",
  "heartbeatMs": 30000,
  "maxReconnectAttempts": 20
}
```

## 接入与身份

启用智能机器人，为 bot ID/Secret 运行单个常驻连接拥有者。多个进程会相互挤掉连接；连接被替换的 `disconnected_event` 报告 `bot_connection_replaced` 并停止重连。白名单使用 `from.userid`，私聊绑定发送者 userid，群聊绑定回调 `chatid`。

## 投递与恢复

`aibotid` 必须匹配，忽略自身消息，正文 `msgid` 用于去重，与传输 `req_id` 分开。群回调由平台限制为机器人交互；不支持的事件不创建任务。独立 `aibot_send_msg` 向冻结聊天输出，转义 Markdown 标点；输入每片最多 2,048 UTF-8 字节，转义正文最多 4,096 字节。成功要求匹配 ACK，没有平台消息 ID；socket 写入不代表送达，ACK 缺少/丢失保留 unknown。忙碌/限流可重试，重连从 1 秒退避到 30 秒，达到连续尝试预算后停止。

## 参数与限制

`wsUrl` 默认 `wss://openws.work.weixin.qq.com`，可设置受信私有部署地址；`heartbeatMs` 为 1,000–60,000，默认 30,000；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。

## 账号变更

冻结 bot ID 和规范化 WebSocket URL，不保存 response_url 或临时回调句柄。

## 媒体

长连接接收图片、视频、文件及图文混排。资源链接五分钟有效；持久接收前完成有上限的下载，以每条资源自己的 AES-256-CBC 密钥解密，验证按 32 字节填充的 PKCS#7。语音回调只有平台转写文字，没有音频字节，因此按文字处理。下载链接与密钥不作为附件持久保存。

原生输出依次使用 `aibot_upload_media_init`、最多 512 KiB 的 base64 分片、`aibot_upload_media_finish`，再以 `media_id` 调用独立 `aibot_send_msg`，无需临时回调句柄。PNG/JPEG/GIF 图片与 MP4 视频最多 10 MiB，AMR 语音最多 2 MiB，普通文件最多 20 MiB；最小上传五字节，文件名最多 256 UTF-8 字节。说明文字独立发送；上传失败可重试，最终发送状态不明保留 unknown。

`mediaOrigins` 可配置私有下载服务的准确 origin；公网 HTTPS 执行 DNS 地址策略、字节上限与禁止跳转。回环 HTTP 同时要求准确媒体 origin 和 `allowInsecureLoopback:true`。Core 默认限制 25 MiB，加密下载只额外允许填充包络。

协议依据：[企业微信长连接与媒体上传](https://developer.work.weixin.qq.com/document/path/101463)。本地加密 HTTP、socket、SQLite 重启测试不代表实账号兼容性已验证。

[媒体传输](../media.md)
