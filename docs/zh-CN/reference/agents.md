# Agent 配置与协议

连接已有的 dot 或 Grok Bot，让它接收渠道消息并回信。每个 Agent 连接有自己的 HTTPS MCP 地址：Grok 使用 URL 中的 token，dot 使用 OAuth；Relanox 还需要通过 Grok Routine webhook 或 dot Events 订阅通知它。

| Agent | 需要设置                                              |
| ----- | ----------------------------------------------------- |
| Grok  | MCP 连接、Routine webhook URL 和完整 Authorization 值 |
| dot   | MCP 连接以及使用已授权回调地址的 Events 订阅          |

先将顶层 `publicUrl` 设为你的公开 HTTPS 地址，例如 `https://relay.example.com`，只需配置一次。使用账号中提供的连接器或 Routine 设置填写以下值。界面名称可能不同；这些步骤列出需要的地址和凭据。

以下示例分别将第一个 Agent 配置为 `agent-1`。使用下载配置时保留其中的 ID 和环境变量引用；添加另一个 Agent 时使用 `agent-2` 和 `RELANOX_AGENT_2_*`，不要重复第一个条目。

## 连接 Grok

1. 按[连接 Grok](../agents.md#连接-grok)在 Grok Bot 桌面客户端创建仅由 webhook 触发的例行任务。
2. 在任务详情中复制“POST 到”作为 URL，以 `Bearer <密钥>` 作为 Authorization 值（不要包含 `Authorization:` 字段名），在 Relanox 环境中提供 `RELANOX_AGENT_1_ROUTINE_URL`、`RELANOX_AGENT_1_ROUTINE_AUTHORIZATION`。
3. 使用配置器生成的 MCP token，或在手动配置时生成随机 token，提供为 `RELANOX_AGENT_1_MCP_TOKEN`。手动配置时，在 `relay.endpoints` 添加：

```json
{
  "id": "agent-1",
  "agent": "grok",
  "config": {
    "mcp": {
      "auth": "path",
      "token": { "env": "RELANOX_AGENT_1_MCP_TOKEN" }
    },
    "routineUrl": { "env": "RELANOX_AGENT_1_ROUTINE_URL" },
    "routineAuthorization": { "env": "RELANOX_AGENT_1_ROUTINE_AUTHORIZATION" }
  }
}
```

4. 设置好 `publicUrl` 后重启 Relanox。HTTPS 设置见[部署与备份](../operations.md)。
5. 添加 MCP 连接，地址为 `https://relay.example.com/agents/grok/mcp/agent-1/<URL编码后的RELANOX_AGENT_1_MCP_TOKEN>`。将末段替换为你的 token，按 URL 路径段编码。在 Cursor 控制台通过 **Plugins & MCPs → Add → Custom MCP** 添加，类型选择 **URL**，HTTP headers 和 OAuth 字段留空。
6. 把聊天绑定的 `endpointId` 设为 `agent-1`。
7. 在这个聊天发送短消息，确认收到回信。卡住时用 `status` 查看。

Routine Authorization 变量保存 `Bearer <密钥>`，不包含 `Authorization:` 字段名；MCP 变量保存原始 token。保护这三个变量，Routine URL 也可能包含密钥。

## 连接 dot

1. 使用配置器生成的授权口令，或自行生成至少 32 个字符的随机值，提供为 `RELANOX_AGENT_1_MCP_TOKEN`。
2. 在 `relay.endpoints` 添加以下条目：

```json
{
  "id": "agent-1",
  "agent": "dot",
  "config": {
    "mcp": {
      "auth": "oauth",
      "token": { "env": "RELANOX_AGENT_1_MCP_TOKEN" }
    }
  }
}
```

3. 重启 Relanox，按[连接 dot](../agents.md#连接-dot)在 ChatGPT 添加自定义 MCP 服务器，服务器 URL 为 `https://relay.example.com/agents/dot/mcp/agent-1`，身份验证选择 OAuth。在 Relanox 授权页输入 `RELANOX_AGENT_1_MCP_TOKEN` 的值；它是授权密码，不是固定 Bearer access token。

4. 将聊天绑定的 `endpointId` 设为 `agent-1`，然后在该聊天发送消息。

dot OAuth 要求公网 HTTPS `publicUrl`。Relanox 使用 PKCE S256，支持 ChatGPT OAuth 跳转地址 `https://chatgpt.com/connector_platform_oauth_redirect` 和 `https://chatgpt.com/connector/oauth/<id>`，它们与 Events 回调不同。access token 有效期一小时；refresh token 使用时轮换，授权总有效期为首次授权起 30 天。授权保存在配置的数据库中。重用旧 refresh token 会撤销对应授权；修改配置的口令并重启后，需要重新连接 dot。

`mcp.auth` 可选 `bearer`、`path`、`oauth`，省略时默认 `bearer`，兼容旧配置。Grok 支持 `bearer` 和 `path`；显式使用 `bearer` 时填写不带 token 的 MCP URL，并发送 `Authorization: Bearer <token>`。Relanox 仍支持旧 dot Bearer 配置，但 dot 平台要求 OAuth。

dot 通过 MCP 订阅时提供回调 URL。Relanox 固定接受原生的 `https://connectors.api.openai.com` 来源，并在投递前检查 DNS 解析结果为公网地址。配置文件中无需也不能填写 `callback`。

回调、MCP 和 Grok Routine 请求的超时固定为 10 秒；MCP 和 Grok Routine 请求体限制为 1 MiB。dot 订阅最长保留 24 小时，签名密钥轮换后保留旧密钥签名 60 秒。

Relanox 需要有效的 `relanox.message_available` 订阅才能通知 dot，默认有效期为一天。已检查的 ChatGPT 自定义 MCP 表单没有 Events 订阅或续订开关；自动订阅及续订尚未通过真实账号端到端验证。`dot_no_active_subscription` 表示 Relanox 没有有效订阅，即使 OAuth 已成功也可能出现。请检查插件连接和运行日志；来信已耗尽重试次数时，按[部署与备份](../operations.md#查找并恢复卡住的消息)恢复。

## 真实账号验证范围

2026 年 10 月 11 日，使用 Windows Grok Bot 0.68.1 和 Cursor Pro 账号，对隔离的 Relanox 实例完成了验证：webhook 触发例行任务，Grok Bot 发现 MCP 工具并调用 `relanox_send_message`，Relanox 将原样测试标识投递到绑定聊天，数据库状态为 `sent`。Telegram 一侧使用本地 HTTP 协议测试端，并非真实 Telegram 账号。这验证了 Grok Routine/MCP 的文字往返，不代表真实渠道账号或附件兼容性已验证。

## MCP 自带回信说明

Agent 连接 MCP 时，Relanox 会提供回信说明，工具描述也会解释各个参数。无需向 bot 或 Routine 手动复制回信 prompt。

这些说明涵盖 dot 事件与 Grok Routine 消息的读取方式、保留 `replyTo`、读取附件、回复原聊天，以及避免重复发送的重试规则。来信中的文字、上下文和附件仍作为不可信的用户内容处理。工具返回 `queued` 表示回信已保存等待投递，不表示平台已经收到。

更新 Relanox 后，重新连接或刷新 Agent 的 MCP 连接，使其重新读取服务说明和工具定义。Agent 平台决定如何使用这些元数据；完成连接后，发送一条消息并确认原聊天收到回信。

## 发送文字和附件

文字回信调用 `relanox_send_message`：

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "text": "你好，有什么需要帮忙的？",
  "idempotencyKey": "COPY_FROM_THE_INCOMING_MESSAGE:answer:1"
}
```

查看收到的附件时，使用相同 `replyTo` 和附件的 `id` 作为 `mediaId` 调用 `relanox_read_media`。它返回可读的图片、音频或下载链接，下载链接五分钟后过期。

转发收到的附件时，在 `attachments` 中放入 `{ "mediaId": "..." }`。生成文件使用公开 HTTPS URL：

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "text": "这是你要的图片。",
  "attachments": [
    {
      "url": "https://files.example.com/result.png",
      "kind": "image",
      "mimeType": "image/png",
      "fileName": "result.png"
    }
  ]
}
```

Relanox 下载并保存文件后投递。使用可直接访问的 URL、准确类型和符合限制的大小。音视频平台可能需要 `durationMs`，视频可能需要 `previewUrl` 或收到的 `previewMediaId`。见[收发图片和文件](../media.md)和对应渠道指南。

## 检查连接

发送渠道消息并收到 Agent 回信。在 `status` 中，来信 `accepted` 表示通知已接收，回信 `sent` 表示平台已接收。MCP 返回 `queued` 表示 Relanox 已保存待发送的回信。

MCP 认证失败时核对 token 和 URL，检查 `publicUrl` 与公开地址一致，并让代理保留 Host。客户端发送 Origin 时，将其准确来源加入 `mcp.allowedOrigins`。Grok 没收到消息时核对 Routine URL 和 Authorization；dot 没收到消息时检查有效订阅及原生 OpenAI 回调地址是否可达。
