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

为企业自建应用启用机器人能力及消息收发权限，配置加密/签名 HTTP 事件订阅 v2.0，地址为 `https://relay.example/channels/<accountId>/events`，订阅 `im.message.receive_v1`。认证使用企业自建应用的 tenant access token。白名单使用 `open_id`，绑定 `message.chat_id` 和 `message.thread_id`，缺少后者时使用 `root_id`。

## 投递与恢复

验证原始正文签名和五分钟时效，按需解密 AES-256-CBC 封装，并校验 token、应用和租户。注册挑战可无签名，但仍校验 verification token。`header.event_id` 去重，接收 `message.content` 中人类文字及原生媒体。延迟回复使用原消息 reply API，并按线程设置 `reply_in_thread`；缺少引用时按 chat ID 创建消息。租户令牌仅在内存缓存，过期/凭据轮换时刷新。每片最多 10,000 UTF-8 字节。发消息前临时令牌失败可重试，提交不确定时保留 unknown。

## 参数与限制

`domain` 为 `feishu`（默认）或 `lark`，对应 `https://open.feishu.cn` 或 `https://open.larksuite.com`。可用 `apiBaseUrl` 覆盖；`timeoutMs` 为 100–60,000，默认 10,000；`allowInsecureLoopback` 默认 false。

## 原生媒体

除消息权限外，授予资源下载、上传权限（`im:resource` 或对应的新上传权限）。接收原生图片、音频、视频、文件，以及含文字、图片或视频资源的富文本；多语言富文本选取第一个语言。通过 `messages/{message_id}/resources/{key}?type=image|file` 携带租户令牌下载用户消息资源，不能用仅供应用自有资源的图片或文件下载 API 替代。

图片用 multipart `im/v1/images`（`image_type=message`），其他资源用 `im/v1/files` 上传，再调用冻结的消息或回复 API。图片最多 10 MiB，其他上传最多 30 MiB，消息资源下载最多 100 MiB，同时受中转限制。音频需 Opus/Ogg 和 `durationMs`；视频需 MP4 和 `durationMs`，可附可选的生成 previewUrl 或已有 previewMediaId；普通文件使用 `file_type=stream`。回复文字另发，不支持的格式或缺失元数据在消息效果前拒绝。

参见[媒体传输](../media.md)、官方[资源 API](https://open.feishu.cn/document/server-docs/im-v1/message/get-2)、[文件上传](https://open.feishu.cn/document/server-docs/im-v1/file/create)及[官方 SDK](https://github.com/larksuite/node-sdk/blob/main/channel/outbound/media/uploader.ts)。本地测试验证协议传输，未验证真实租户权限或播放。

## 账号变更

冻结应用、租户、机器人 open ID 和规范化 API 地址。
