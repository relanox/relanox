# 飞书 / Lark

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "appId": "cli_example",
  "appSecret": {
    "env": "FEISHU_APP_SECRET"
  },
  "verificationToken": {
    "env": "FEISHU_VERIFICATION_TOKEN"
  },
  "encryptKey": {
    "env": "FEISHU_ENCRYPT_KEY"
  },
  "tenantKey": "example-tenant",
  "botOpenId": "ou_example_bot",
  "domain": "feishu"
}
```

## 接入与身份

为企业自建应用启用机器人能力及消息收发权限，配置加密/签名 HTTP 事件订阅 v2.0，地址为 `https://relay.example/channels/<accountId>/events`，订阅 `im.message.receive_v1`。不支持 ISV app-ticket 认证及飞书 WebSocket 接收。白名单使用 `open_id`，绑定 `message.chat_id` 和 `message.thread_id`，缺少后者时使用 `root_id`。

## 投递与恢复

验证原始正文签名和五分钟时效，按需解密 AES-256-CBC 封装，并校验 token、应用和租户。注册挑战可无签名，但仍校验 verification token。`header.event_id` 去重，仅接收 `message.content` 中人类文字。延迟回复使用原消息 reply API，并按线程设置 `reply_in_thread`；缺少引用时按 chat ID 创建消息。租户令牌仅在内存缓存，过期/凭据轮换时刷新。每片最多 10,000 UTF-8 字节。发消息前临时令牌失败可重试，提交不确定时保留 unknown。

## 参数与限制

`domain` 为 `feishu`（默认）或 `lark`，对应 `https://open.feishu.cn` 或 `https://open.larksuite.com`。可用 `apiBaseUrl` 覆盖；`timeoutMs` 为 100–60,000，默认 10,000；`allowInsecureLoopback` 默认 false。不支持富消息、卡片、媒体、编辑及应用发送者。

## 账号变更

冻结应用、租户、机器人 open ID 和规范化 API 地址。
