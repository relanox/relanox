# 云端 Agent

Relanox 连接已有的 dot、Grok 和 Muse Agent。每个端点有独立 MCP 路由、凭据和会话范围，
通过会话绑定与通道关联，绑定必须使用准确的会话 ID。

## dot

```sh
relanox agent add --id dot --agent dot
```

端点采用 HTTPS OAuth 和原生 MCP Events。将打印出的
`https://relay.example.com/agents/dot/mcp/dot` 添加到宿主连接器设置。生成的 MCP 凭据
是该 OAuth 端点的登录密码，不能当作 bearer token 使用。完成设置后会打印凭据路径和
环境变量名称。原生事件订阅应使用触发消息准确的请求 ID。

MCP 使用[官方 Go SDK](https://github.com/modelcontextprotocol/go-sdk)，事件签名使用
[Standard Webhooks Go 库](https://github.com/standard-webhooks/standard-webhooks/tree/libraries/v0.0.1/libraries/go)。
[原生 MCP Events](https://developers.openai.com/plugins/build/mcp-events) 要求协议版本
`2026-07-28`；订阅会持久化并跨重启保留，需要在获准的到期时间前续订。

## Grok

```sh
relanox agent add --id grok --agent grok
```

使用拥有该 Bot 和 MCP 连接的 Cursor 账号登录 Grok Bot。在应用中创建由 webhook 触发的
Routine，再输入其 URL 和完整 Authorization 值。
Relanox 向该 URL POST 原生通知。为 Routine 连接打印出的 MCP URL，并配置生成的
bearer 凭据，以读取消息和回复。原生配置也支持 `mcp.auth = "path"`；CLI 只打印
`<token>` 占位符，不泄露路径凭据。

Cursor 的[官方 Routine webhook 契约](https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean)
要求发送 HTTP POST、`Authorization: Bearer <key>` 和 JSON 正文。只有 HTTP `200`
确认已启动一次运行，不代表最终回复完成；传输中断而未收到响应仍属于结果不明。
Relanox 通过 HTTP 调用 Routine webhook，超时为 10 秒，并在调用者取消 context 时取消请求。
MCP 使用官方 Go SDK。

## Muse

```sh
relanox agent add --id muse --agent muse --credentials-directory paired/muse
```

先通过[官方 Muse gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux)
流程完成设备配对。目录应包含 `pairing.json`、`identity.json`
和可选的 `sdk_token`。这是相对于 Relanox 配置的普通目录路径，不是凭据引用；目录需
可写，以保存刷新后的凭据。Relanox 使用配对设备的原生加密传输和云端 MCP。

原生 JSON 选项中的 `vmId` 与 `sessionId` 可选择指定目标。CLI 导入已有配对。
使用该目录前先停止 SDK 守护进程；每个独立运行的部署必须使用自己的配对，
避免多个客户端同时使用不断更新的刷新令牌。更换或撤销配对时使用的 SDK
token 后需要重新配对。

上游设备 SDK 面向 Linux Python 和 ESP32 C。Relanox 使用
[`flynn/noise`](https://github.com/flynn/noise) 处理原生 Noise XX 握手与 AES-GCM 状态，
Muse 专用分帧及账号操作依据官方 SDK 适配。通知传递文本和附件元数据，媒体通过有访问权限限制的
MCP 工具传输。本地检查对比官方 SDK 生成的固定字节，并验证加密 HTTP/WebSocket 流量，
不代表已验证真实 Muse 账号兼容性。

## 请求、回复与媒体

共享工具为 `relanox_read_messages`、`relanox_status` 和 `relanox_send_message`。
通知包含准确 `requestId`。最终回复携带
`{ "requestId": "...", "kind": "final" }`；进度回复使用 `kind = "progress"`，
不会完成请求。流式回复不在当前支持范围。

每次读取、媒体操作和发送都会重新检查端点当前的会话权限。队列保存接收时确定的端点，
修改会话绑定不会转移已接收的任务。Agent 读取的消息不包含私有原生回复地址或凭据引用。

各通道支持的媒体类型不同。按照 MCP 工具公布的 schema 和媒体引用发送；状态工具会报告原生
文本限制、媒体类型、富文本与可用性。排队成功代表回复已持久化，原生发送仍可能失败或
产生结果不明状态。
