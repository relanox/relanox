# 企业微信智能机器人

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

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

`aibotid` 必须匹配，忽略自身消息，正文 `msgid` 用于去重，与传输 `req_id` 分开。群回调由平台限制为机器人交互；非文字媒体/事件不创建任务。独立 `aibot_send_msg` 向冻结聊天输出，转义 Markdown 标点；输入每片最多 2,048 UTF-8 字节，转义正文最多 4,096 字节，不使用临时流式回复 API。成功要求匹配 ACK，没有平台消息 ID；socket 写入不代表送达，ACK 缺少/丢失保留 unknown。忙碌/限流可重试，重连从 1 秒退避到 30 秒，达到连续尝试预算后停止。

## 参数与限制

`wsUrl` 默认 `wss://openws.work.weixin.qq.com`，可设置受信私有部署地址；`heartbeatMs` 为 1,000–60,000，默认 30,000；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。

## 账号变更

冻结 bot ID 和规范化 WebSocket URL，不保存 response_url 或临时回调句柄。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
