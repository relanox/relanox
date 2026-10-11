# IRC

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "server": "irc.example.com",
  "port": 6697,
  "tls": true,
  "nick": "relanox",
  "channels": ["#support"],
  "sasl": {
    "username": "relanox",
    "password": {
      "env": "IRC_SASL_PASSWORD"
    }
  }
}
```

## 接入与身份

连接 TLS IRC 网络，可选 password 为服务器 PASS 密钥，sasl 配置 SASL PLAIN，配置后必须成功。协商 account-tag、server-time、message-tags，welcome 后加入频道。默认要求已认证 account tag，白名单 `account:<account-name>`；绑定配置频道原拼写或 `dm:<RFC1459-folded-sender-nick>`。allowNickFallback:true 允许 `nick:<folded-nick>` 并警告；昵称/延迟私聊目标可能易主，无稳定按账号寻址私聊 API。

## 投递与恢复

处理 PING/PONG，忽略 CTCP、命令和自身回显。有 msgid 时去重，否则本地行 ID 不保证重放去重。重连后继续接收新消息。PRIVMSG 每片最多 400 UTF-8 字节，目标最多 90 字节，保持 512 字节行上限；换行为空格，拒绝 NUL。成功回执仅表示 acknowledgement:socket_write，不证明服务器接纳或收件人送达；传输不确定保留 unknown。

## 参数与限制

`server`/`nick` 必填；port 默认 6697；tls 默认 true；channels 默认空，最多 100；allowNickFallback 默认 false；`timeoutMs` 为 100–120,000，默认 10,000；`reconnectMs` 为 100–60,000，默认 1,000。明文 TCP 必须回环加 allowInsecureLocalhost:true，TLS 证书验证不可远程关闭。

## 账号变更

冻结服务器、端口和 TLS 模式。

IRC 通过原生 PRIVMSG 收发文字消息。

[媒体传输](../media.md)
