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

创建专用账号/设备并加入房间，使用 Client-Server `/sync` 接收和房间 API 发送。白名单为准确 MXID，绑定房间 ID 和可选原始 m.thread 根事件 ID。仅 m.text，忽略自身事件、编辑/其他关系、媒体和成员操作。不支持加密房间，不解密或管理密钥。

## 投递与恢复

全部事件持久接收或明确排除后推进持久 sync 游标，重放按事件 ID 去重。已有游标遇 limited timeline 报告 `sync_history_gap` 并停止推进，不补拉历史，需运维解决。发送先检查加密状态，检查临时失败可安全重试。PUT 输出复用分片 transaction ID，去重依赖同一设备/端点，替换令牌/设备可能失去范围；unknown 需显式恢复。回复保留原事件/线程关系，每片最多 16,000 UTF-8 字节。

## 参数与限制

`homeserver`/`userId` 必填；`timeoutMs` 为 100–120,000，默认 10,000；`syncTimeoutMs` 为 0–60,000，默认 30,000；`reconnectMs` 为 100–60,000，默认 1,000；`allowInsecureLocalhost` 默认 false。Sync 允许长轮询时长加请求超时。

## 账号变更

冻结 homeserver 和配置的用户 ID。
