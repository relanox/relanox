# IRC

通过专用 IRC 昵称，在频道和私聊中回答文字消息。

## 准备账号

选择支持认证账号标签的 TLS IRC 服务器，注册机器人昵称和账号，将 SASL 密码保存到 `IRC_SASL_PASSWORD`。取得加入所选频道及发言权限。网络另需服务器密码时，添加 `password: {"env":"IRC_SERVER_PASSWORD"}`。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "irc-main",
      "config": {
        "server": "irc.example.com",
        "port": 6697,
        "tls": true,
        "nick": "relanox",
        "sasl": {
          "username": "relanox",
          "password": {
            "env": "IRC_SASL_PASSWORD"
          }
        }
      },
      "channel": "irc",
      "allowedSenders": ["account:alice"]
    }
  ],
  "bindings": [
    {
      "accountId": "irc-main",
      "chatId": "#support",
      "endpointId": "my-agent"
    }
  ]
}
```

允许发送者填写 `account:<account-name>`，使用用户已认证的网络账号，可从带账号标签的消息或网络账号信息取得。频道 `chatId` 使用配置中的准确频道名。私聊绑定使用 `dm:<folded-nick>`，按 IRC 的 RFC1459 规则规范化昵称（小写，并将 `[]\^` 转为 `{}|~`）。例如 Alice 使用 `dm:alice`。

## 启用连接

填写服务器主机名、TLS 端口和昵称。启动后会自动登录，并加入该账号聊天绑定中的频道，无需另填频道列表。保持进程连接以接收新消息。

## 发送第一条消息

登录自己的 IRC 账号，在绑定频道或机器人昵称的私聊中发送“你好”。回答以普通文字行显示，较长回答会拆为多行。

## 图片和文件

IRC 适合文字提问。需要向 Agent 提交图片或文件时，可在[渠道指南](../configuration.md)中选择 Telegram、Discord 或 Matrix 等带附件的渠道。

## 常见问题

消息被过滤时，确认 IRC 客户端已登录网络账号且服务器发送账号标签。使用昵称身份的网络可由管理员显式启用 `allowNickFallback:true`，并允许 `nick:<folded-nick>`；仅在访问策略可接受昵称归属变化时使用。机器人无法加入频道时，检查 SASL 凭据和频道权限。
