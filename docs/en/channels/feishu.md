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

HTTP events verify raw-body signatures with a five-minute freshness bound and decrypt encrypted envelopes. Registration challenges may be unsigned but must match the verification token. Normal events must match token, app and tenant identities. `header.event_id` deduplicates deliveries; allowlists use sender `open_id`. Only human text from `message.content` is relayed.

Bind `message.chat_id` and, when present, `message.thread_id` (otherwise `root_id`). Replies freeze the source `message_id` and tenant, and use the independent `messages/{id}/reply` API with `reply_in_thread` when a thread exists. A target without a reply reference uses `messages?receive_id_type=chat_id`. No expiring response token is persisted. Tenant access tokens refresh before expiry and stay in memory; credential rotation invalidates the token cache. Message text is encoded inside the API's JSON string `content`. Text is split at 10000 UTF8 bytes. 429 and transient token-acquisition failures before message submission are retryable; uncertain message-send transport results remain unknown; durable idempotency is false.

Optional config: `domain` (`feishu` or `lark`, default `feishu`), `apiBaseUrl` override (defaults to `https://open.feishu.cn` or `https://open.larksuite.com`), `timeoutMs` (default 10000), `allowInsecureLoopback` (default false). Custom URLs support enterprise proxies; cleartext requires literal loopback/localhost opt-in, credentials/redirects are rejected.

## Account changes

Accepted targets freeze the application, tenant, bot open ID and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.
