# 通过 signal-cli 接入 Signal

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "serviceUrl": "https://signal-bridge.example.com",
  "account": "+15551234567",
  "selfUuid": "the_registered_accounts_uuid",
  "authorization": {
    "env": "SIGNAL_BRIDGE_AUTHORIZATION"
  }
}
```

## 接入与身份

需要自行安装、注册并维护非官方 signal-cli HTTP JSON-RPC/SSE daemon，此处没有官方 Signal Bot API。Relanox 不注册号码、安装 daemon 或管理其账号/加密/会话存储。daemon 应保持私网访问，远程访问使用认证 TLS 代理。白名单优先 sourceUuid，缺少时使用号码/source；绑定 `direct:<sender>` 或 `group:<groupId>`。建议 selfUuid 排除自身 UUID；非文字、阅后即焚、回执、输入状态和自身事件不建任务。

## 投递与恢复

SSE `/api/v1/events?account=<account>` 持久接收后保存 ID，重连携带 Last-Event-ID。上游缓冲有限且仅在内存，daemon 重启或长时间断线可能丢历史。独立 `/api/v1/rpc` JSON-RPC send 要求匹配 RPC ID 和结果时间戳，提供的收件人结果必须全为 SUCCESS。群部分失败保留 unknown，避免重复成功成员；兼容旧版仅时间戳响应。每片最多 16,000 UTF-8 字节。signal-cli 账号/会话状态须在 Relanox 数据库之外单独备份。

## 参数与限制

`serviceUrl`/`account` 必填；可选 authorization 向可信代理提供完整 Authorization 头；`timeoutMs` 为 100–120,000，默认 10,000；`reconnectMs` 为 100–60,000，默认 1,000；`allowInsecureLocalhost` 默认 false，仅本地 HTTP daemon 可显式设 true。

## 账号变更

冻结桥接 URL 和配置的 Signal 账号。

## 原生媒体

支持图片、音频、视频和文件附件，也接收纯附件消息；不处理阅后即焚、回执、输入状态或自身消息。附件元数据来自认证 daemon 事件，调用原生 JSON-RPC getAttachment，传入配置账号、附件 ID 和原发送者或群组 ID。验证返回的 `{data}` base64，并同时限制响应编码大小和解码字节数。Daemon 必须已经下载附件；文件缺失或超限时不推进 SSE 游标。不会读取任意 URL 或 daemon 文件路径。

输出通过原生 send attachments 传递包含 MIME、文件名和完整字节的 RFC 2397 data URI。图片、音频、视频和文件使用同一原生附件接口，该接口没有独立时长或预览字段。媒体完整缓冲并持久保存，不支持流式传输；仍受 Signal 原生上限和 daemon 外部附件保留策略限制。本地 SSE、JSON-RPC、SQLite 和 MCP 测试验证字节收发与群组目标，不证明真实账号兼容。

协议来源：[signal-cli 手册](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc#getattachment)、[JSON-RPC 手册](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)。
