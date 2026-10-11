# Mattermost

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "serverUrl": "https://mattermost.example.com",
  "botUserId": "dedicated_bot_user_id",
  "token": {
    "env": "MATTERMOST_TOKEN"
  }
}
```

## 接入与身份

创建专用机器人账号，授予目标频道读写权限。WebSocket 通过 token authentication_challenge 认证，接收 posted 事件。白名单为用户 ID，绑定频道 ID 和可选根帖子 ID threadId。解码 data.post，忽略自身帖子、没有文本或文件的空消息和系统/非标准类型。

## 投递与恢复

稳定帖子 ID 去重，断线后重新认证，但没有历史重放，离线消息可能丢失。独立 `POST /api/v4/posts` 使用冻结 channel_id 和可选 root_id，成功要求帖子 ID。每片最多 16,000 个码点；429 可重试，明确 4xx 拒绝，传输/5xx/格式错误的成功响应保留 unknown。

## 参数与限制

`serverUrl`/`botUserId` 必填；`timeoutMs` 为 100–120,000，默认 10,000；`reconnectMs` 为 100–60,000，默认 1,000；`allowInsecureLocalhost` 默认 false。

## 账号变更

冻结服务器 URL 和配置的机器人用户 ID。

## 原生媒体

posted 事件的 file_ids 先通过 `GET /api/v4/files/<id>/info` 获取元数据，再使用配置 token 调用 `GET /api/v4/files/<id>` 下载。MIME 元数据区分图片、音频、视频和其他文件；请求固定到配置服务器，拒绝重定向并遵守核心字节限制，不下载消息提供的任意 URL。

输出向 `POST /api/v4/files` 上传包含 files 和 channel_id 的二进制 multipart，再以 file_ids 创建冻结线程帖子。原生预览由服务器按 MIME 生成。核心保留附件顺序。机器人需要 upload_file/read_channel 权限，并遵守服务器文件大小上限。媒体完整缓冲并持久存储。本地 WebSocket、HTTP、SQLite 和 MCP 测试验证字节传输与线程信息。

协议来源：[Mattermost 文件 API](https://github.com/mattermost/mattermost/blob/master/api/v4/source/files.yaml)。

媒体上传在提交收件人消息前完成。上传传输错误、无效上传响应及服务端失败可重试；明确的客户端拒绝保持拒绝，限流遵循重试间隔。随后发送消息仍保留通常的结果不确定性处理。

[媒体传输](../media.md)
