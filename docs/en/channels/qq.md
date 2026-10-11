# QQ C2C and groups

## Media

C2C/group attachments become durable bytes before the gateway cursor advances, including pure-media messages. Downloads enforce DNS/byte limits and refuse redirects. `mediaOrigins` optionally contains exact private download origins; loopback HTTP also requires `allowInsecureLoopback:true`.

Configure top-level relay `media.publicBaseUrl` so QQ can fetch output bytes. The adapter calls `/v2/users/<id>/files` or `/v2/groups/<id>/files` with `srv_send_msg:false`, then sends `msg_type:7` and `media.file_info`, retaining durable passive reply allocation. Every attempt obtains fresh file_info to avoid TTL expiry; C2C/group tokens never mix. Captions precede media as separate text chunks. Publication URLs are short lived and account/request scoped.

The current protocol supports PNG/JPEG images, MP4 video, SILK audio and ordinary files (`file_type:4`). It does not transcode. Platform soft limits are 20 MiB image/audio, 30 MiB video and 200 MiB files; the default 25 MiB relay limit also applies. Uploading never implicitly sends proactive messages.

Protocols: [rich media](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html), [group upload](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html). Local HTTP/socket and SQLite tests do not establish live-account compatibility.

Enable an official QQ robot with GROUP_AND_C2C_EVENT permission. Websocket transport supports C2C and group @robot text/media; there is no Webhook or guild/channel reception.

Account `config` ([configuration](../configuration.md)):

```json
{
  "appId": "robot-app-id",
  "clientSecret": {
    "env": "QQ_CLIENT_SECRET"
  },
  "transport": "websocket",
  "apiBase": "https://api.bot.qq.com",
  "allowProactive": false,
  "maxReconnectAttempts": 20
}
```

## Setup and delivery

Authentication POSTs `/app/getAppAccessToken` on `api.bot.qq.com`, then uses `Authorization: QQBot ACCESS_TOKEN`. The deprecated static Bot token scheme is rejected by configuration validation. Access tokens are memory-only and refresh before expiry, after an explicit HTTP 401 or environment credential rotation. Tokens are never stored in targets, plugin state or logs. API configuration is a trusted operator choice; redirects are refused. `allowInsecureLoopback:true` permits plain HTTP/WS exclusively on loopback for local peers, not on remote service domains.

The plugin discovers `/gateway`, handles Hello, identifies with `intents=1<<25` and shard `[0,1]`, retains the session and last committed dispatch cursor for reconnect Resume, and implements heartbeat ACKs. Incoming dispatches are serialized, while heartbeat/control processing continues during durable ingestion. Resume can deliver messages before RESUMED; these are accepted. The cursor advances after durable ingestion succeeds. This cursor is process-local: process restart establishes a new session; storage event deduplication and frozen targets survive restart. No replay guarantee is claimed across a full process restart. Invalid session/cursor/internal gateway errors reset to Identify; explicit forbidden intent, invalid shard and banned/offline bot close codes stop recovery and report degradation. Reconnect backoff caps at 30 seconds with a configured consecutive attempt budget; stop/AbortSignal cancel timers and the owned socket.

C2C bindings and allowlists use `author.user_openid`. Group bindings use `group_openid`, and group allowlists use `author.member_openid`. `GROUP_AT_MESSAGE_CREATE` content already excludes the platform @robot prefix and is retained verbatim. Bot-authored events and unsupported message types are diagnosed and ignored. Text and rich-media message types (0 and 7) preserve attachments as durable request bytes, including pure-media events. Stable source identity includes event type, body message ID and the published `message_scene.ext` msg_idx (or msg_seq when present); gateway `s` is never the source ID. The msg_idx distinguishes documented indexed parts. Other scene fields, especially short-lived auth_token, are not persisted.

Durable target data is `{type:"c2c"|"group",msgId,messageAt,scope:{appId,apiBase}}` beside the frozen user/group OpenID. Sends use `/v2/users/{openid}/messages` or `/v2/groups/{openid}/messages`, `msg_type:0` and `content`. Chunks use a conservative 2000 UTF-8 byte limit. Before sending, each chunk receives a durable msg_seq allocation; retries and restart reuse it. Protocol state stores no credentials and is bounded to 256 chunk allocations per source message.

Published passive limits are C2C 60 minutes and 4 replies per source message; group 5 minutes and 5 replies. The window uses the platform message timestamp, not restart or delayed acceptance time. The remote API can reject earlier; that terminal result is preserved.

When a fresh chunk has exhausted/expired passive permission, the default preserves the result as rejected. Setting `allowProactive:true` explicitly permits that chunk to use proactive sending without msg_id/msg_seq. This also requires platform/account permission and the user's/group's active receiving preference; the plugin cannot grant either. An existing passive allocation never changes to proactive during a retry, avoiding a different external effect after an uncertain send. It likewise does not silently convert an API permission/window rejection to another send. Operators review the preserved result and can explicitly recover it.

`idempotentSend=false` applies to the account because proactive sends have no documented durable deduplication. Passive duplicate responses prove suppression, not a recoverable platform receipt, so `40054005` stays unknown instead of claiming success. HTTP 429 uses bounded Retry-After; documented temporary codes retry; window/permission/format codes reject; unclassified 5xx, malformed responses and broken connections stay unknown. An accepted response's actual `id` becomes platformMessageId.

Accepted targets also freeze the app ID and normalized API base URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

`maxReconnectAttempts` accepts 0–1,000 and defaults to 20.

[Media transfer](../media.md)
