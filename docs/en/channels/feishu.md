# Feishu / Lark

Use an internal/self-built application with HTTP event subscription v2.0.

Account `config` ([configuration](../configuration.md)):

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

## Setup and delivery

Selected transport is native HTTP event subscription v2.0, not the official SDK's persistent WS client. Configure encryption/signature settings and the subscription URL `https://your-relay/channels/feishu-main/events`, subscribe to `im.message.receive_v1`, enable bot capability and message send/receive permissions. This transport supports internal/self-built apps using the tenant-access-token internal endpoint; ISV app-ticket flow is unsupported.

HTTP events verify raw-body signatures with a five-minute freshness bound and decrypt encrypted envelopes. Registration challenges may be unsigned but must match the verification token. Normal events must match token, app and tenant identities. `header.event_id` deduplicates deliveries; allowlists use sender `open_id`. Human text and native media from `message.content` are relayed.

Bind `message.chat_id` and, when present, `message.thread_id` (otherwise `root_id`). Replies freeze the source `message_id` and tenant, and use the independent `messages/{id}/reply` API with `reply_in_thread` when a thread exists. A target without a reply reference uses `messages?receive_id_type=chat_id`. No expiring response token is persisted. Tenant access tokens refresh before expiry and stay in memory; credential rotation invalidates the token cache. Message text is encoded inside the API's JSON string `content`. Text is split at 10000 UTF8 bytes. 429 and transient token-acquisition failures before message submission are retryable; uncertain message-send transport results remain unknown; durable idempotency is false.

Optional config: `domain` (`feishu` or `lark`, default `feishu`), `apiBaseUrl` override (defaults to `https://open.feishu.cn` or `https://open.larksuite.com`), `timeoutMs` (default 10000), `allowInsecureLoopback` (default false). Custom URLs support enterprise proxies; cleartext requires literal loopback/localhost opt-in, credentials/redirects are rejected.

## Native media

Grant resource download/upload permissions (`im:resource`, or the applicable newer upload scope) in addition to message permissions. Native image/audio/media/file messages and rich posts containing text and image/video resources are accepted. The first supplied post locale is selected. Resource keys are resolved through `messages/{message_id}/resources/{key}?type=image|file` using a tenant token; direct image/file downloads cannot replace this API for user-owned message resources.

Generated images use multipart `im/v1/images` (`image_type=message`); other assets use `im/v1/files`, followed by the frozen native message/reply. Upload ceilings are 10 MiB for images and 30 MiB otherwise, plus relay limits; message-resource downloads are capped at 100 MiB. Native audio requires Opus/Ogg and `durationMs`; video requires MP4 and `durationMs`, with an optional staged image `previewMediaId`. Files use `file_type=stream`. Final text is delivered separately. Unsupported codecs and missing metadata are rejected before a message effect.

See [Media transfer](../media.md), the official [resource API](https://open.feishu.cn/document/server-docs/im-v1/message/get-2), [file upload](https://open.feishu.cn/document/server-docs/im-v1/file/create), and [official SDK uploader](https://github.com/larksuite/node-sdk/blob/main/channel/outbound/media/uploader.ts). Local tests establish protocol transport, not live tenant permissions or playback.

## Account changes

Accepted targets freeze the application, tenant, bot open ID and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.
