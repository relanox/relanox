# Signal 与 signal-cli

通过独立维护的 signal-cli 服务，使用专用 Signal 账号。

## 准备账号

安装 signal-cli，注册或关联 Signal 账号，并启动其 HTTP JSON-RPC/SSE 服务。记录账号号码。备份 Relanox 数据库时一并备份 signal-cli 账号/会话数据。远程访问使用带认证的 HTTPS 代理，将完整 Authorization 请求头值保存到 `SIGNAL_BRIDGE_AUTHORIZATION`。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "signal-main",
      "config": {
        "serviceUrl": "https://signal-bridge.example.com",
        "account": "+15551234567",
        "authorization": {
          "env": "SIGNAL_BRIDGE_AUTHORIZATION"
        }
      },
      "channel": "signal",
      "allowedSenders": ["11111111-1111-4111-8111-111111111111"]
    }
  ],
  "bindings": [
    {
      "accountId": "signal-main",
      "chatId": "direct:11111111-1111-4111-8111-111111111111",
      "endpointId": "my-agent"
    }
  ]
}
```

要取得发送者 ID，先发送一条测试消息，让服务管理员查看 `/api/v1/events?account=<account>` 事件流。允许发送者优先使用收到信封的 `sourceUuid`；没有 UUID 时使用号码/source 标识。私聊绑定填写 `direct:<sender>`，群聊填写 `group:<groupId>`。群组 ID 可从服务的群组信息或收到的信封取得。Relanox 会按账号号码过滤自身消息。如果服务发出的自身消息只带 UUID，可另外设置 `selfUuid` 为该账号 UUID，以便同样过滤。

## 启用连接

`serviceUrl` 填服务或代理基础地址，`account` 填已注册账号号码。Relanox 启动时自动连接。同机服务可使用 HTTP 回环地址并添加 `allowInsecureLocalhost:true`；本地服务无需认证时移除 `authorization`。

## 发送第一条消息

用允许的 Signal 联系人，向专用账号或其已加入的绑定群组发送“你好”。保持 signal-cli 和 Relanox 同时运行，以接收问题。

## 图片和文件

正常发送图片、音频、视频或文件。确保 signal-cli 下载接收附件，以便 Relanox 获取。生成附件通过同一专用 Signal 账号发出，并需符合 Signal 与 Relanox 媒体限制。

## 常见问题

消息缺失时，检查服务的注册账号、事件流和代理认证。附件失败时，确认 signal-cli 已下载并保留附件。服务重启或长时间断线后，重新发送仍未得到回答的问题。
