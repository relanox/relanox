# Feishu / Lark

`@relanox/channel-feishu` exports `createFeishuChannel(environment = process.env)`, one instance per internal application/tenant account.

```json
{
  "id": "feishu-main",
  "channel": "feishu",
  "allowedSenders": ["ou_example_user"],
  "config": {
    "appId": "cli_example",
    "appSecret": { "env": "FEISHU_APP_SECRET" },
    "verificationToken": { "env": "FEISHU_VERIFICATION_TOKEN" },
    "encryptKey": { "env": "FEISHU_ENCRYPT_KEY" },
    "tenantKey": "example-tenant",
    "botOpenId": "ou_example_bot",
    "domain": "feishu"
  }
}
```

Selected transport is native HTTP event subscription v2.0, not the official SDK's persistent WS client. Configure encryption/signature settings and the subscription URL `https://your-relay/channels/feishu-main/events`, subscribe to `im.message.receive_v1`, enable bot capability and message send/receive permissions. This baseline is for internal/self-built apps using the tenant-access-token internal endpoint; ISV app-ticket flow is unsupported.

Protocol checked 2026-10-11 against official [event dispatcher](https://github.com/larksuite/node-sdk/blob/main/dispatcher/request-handle.ts), [AES cipher](https://github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts), [typed events](https://github.com/larksuite/node-sdk/blob/main/code-gen/events-template.ts), [message API schemas](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/im.ts), [receive](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive), [create](https://open.feishu.cn/document/server-docs/im-v1/message/create) and [reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply). No runtime dependency on the SDK/reference implementation is included.

Signed raw bytes use timestamp + nonce + encrypt key + body SHA256 with a five-minute freshness bound. AES256-CBC encrypted envelopes use SHA256(key), the first 16 decoded bytes as IV, and normal PKCS padding. Signed plaintext is also accepted. URL verification checks the validation token after decryption; events require matching token, app and tenant identities. Source key is `header.event_id`; sender allowlists use `open_id`. Human text comes from the JSON string `message.content`. Unsupported event/media/app senders are diagnosed and skipped.

Bind `message.chat_id` and, when present, `message.thread_id` (otherwise `root_id`). Replies freeze the source `message_id` and tenant, and use the independent `messages/{id}/reply` API with `reply_in_thread` when a thread exists. A target without a reply reference uses `messages?receive_id_type=chat_id`. No expiring response token is persisted. Tenant access tokens refresh before expiry and stay in memory; credential rotation invalidates the token cache. Message text is encoded inside the API's JSON string `content`. Core chunks conservatively at 10000 UTF8 bytes. 429 and transient token-acquisition failures before message submission are retryable; uncertain message-send transport results remain unknown; durable idempotency is false.

Optional config: `domain` (`feishu` or `lark`, default `feishu`), `apiBaseUrl` override (defaults to `https://open.feishu.cn` or `https://open.larksuite.com`), `timeoutMs` (default 10000), `allowInsecureLoopback` (default false). Custom URLs support enterprise proxies; cleartext requires literal loopback/localhost opt-in, credentials/redirects are rejected.

Local signed/encrypted HTTP and token/message peers were tested. Real-account support is experimental. Rich messages, cards, media, edits, ISV app tickets and Feishu WS transport are unsupported.
