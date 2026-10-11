# Matrix

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "homeserver": "https://matrix.example.com",
  "userId": "@relay:example.com",
  "accessToken": {
    "env": "MATRIX_ACCESS_TOKEN"
  }
}
```

## 接入与身份

创建专用账号/设备并加入房间，使用 Client-Server `/sync` 接收和房间 API 发送。白名单为准确 MXID，绑定房间 ID 和可选原始 m.thread 根事件 ID。接收 m.text、m.image、m.audio、m.video 和 m.file，忽略自身事件、编辑/其他关系和成员操作。使用未加密房间。

## 投递与恢复

全部事件持久接收或明确排除后推进持久 sync 游标，重放按事件 ID 去重。已有游标遇 limited timeline 报告 `sync_history_gap` 并停止推进，不补拉历史，需运维解决。发送先检查加密状态，检查临时失败可安全重试。PUT 输出复用分片 transaction ID，去重依赖同一设备/端点，替换令牌/设备可能失去范围；unknown 需显式恢复。回复保留原事件/线程关系，每片最多 16,000 UTF-8 字节。

## 参数与限制

`homeserver`/`userId` 必填；`timeoutMs` 为 100–120,000，默认 10,000；`syncTimeoutMs` 为 0–60,000，默认 30,000；`reconnectMs` 为 100–60,000，默认 1,000；`allowInsecureLocalhost` 默认 false。Sync 允许长轮询时长加请求超时。

## 账号变更

冻结 homeserver 和配置的用户 ID。

## 原生媒体

图片、音频、视频和文件通过配置 homeserver 的认证接口 `/_matrix/client/v1/media/download/<server>/<mediaId>` 下载。`mxc://` 中的服务器名仅作媒体标识，不会变成携带凭证的下载目标。下载拒绝重定向并遵守核心字节限制；附件使用未加密文件。

输出先调用 `POST /_matrix/media/v3/upload`，再发送对应的 m.image、m.audio、m.video 或 m.file 房间事件。保留文件名、MIME、大小和可选时长；同一请求已有图片预览会上传并写入 thumbnail_url/thumbnail_info。核心按顺序在文本后发送结果附件。上传或发送结果不明确时遵守已有 unknown 恢复规则。媒体完整缓冲并持久保存；homeserver 上限可能低于核心上限。本地 HTTP、SQLite 和 MCP 测试验证协议约定。

协议来源：[Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/)。

媒体上传在提交收件人消息前完成。上传传输错误、无效上传响应及服务端失败可重试；明确的客户端拒绝保持拒绝，限流遵循重试间隔。随后发送消息仍保留通常的结果不确定性处理。 原生媒体事件提供独立 `filename` 时，与其不同的 `body` 会作为说明正文与附件一起保存。

[媒体传输](../media.md)
