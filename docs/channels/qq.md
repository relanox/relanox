# QQ C2C and group text

`@relanox/channel-qq` exports `createQqChannel()`. The declared transport is `websocket`; this initial implementation supports official C2C text and group @robot text. It does not expose a Webhook endpoint or receive guild/channel messages. An enabled QQ robot and GROUP_AND_C2C_EVENT permission are required.

```json
{
  "id": "qq-work",
  "channel": "qq",
  "allowedSenders": ["user-openid", "group-member-openid"],
  "config": {
    "appId": "robot-app-id",
    "clientSecret": { "env": "QQ_CLIENT_SECRET" },
    "transport": "websocket",
    "apiBase": "https://api.bot.qq.com",
    "allowProactive": false,
    "maxReconnectAttempts": 20
  }
}
```

Current authentication POSTs `/app/getAppAccessToken` on `api.bot.qq.com`, then uses `Authorization: QQBot ACCESS_TOKEN`. The deprecated static Bot token scheme is rejected by configuration validation. Access tokens are memory-only and refresh before expiry, after an explicit HTTP 401 or environment credential rotation. Tokens are never stored in targets, plugin state or logs. API configuration is a trusted operator choice; redirects are refused. `allowInsecureLoopback:true` permits plain HTTP/WS exclusively on loopback for local peers, not on remote service domains.

The plugin discovers `/gateway`, handles Hello, identifies with `intents=1<<25` and shard `[0,1]`, retains the session and last committed dispatch cursor for reconnect Resume, and implements heartbeat ACKs. Incoming dispatches are serialized, while heartbeat/control processing continues during durable ingestion. Resume can deliver messages before RESUMED; these are accepted. The cursor advances after Host.ingest succeeds. This cursor is process-local: process restart establishes a new session; storage event deduplication and frozen targets survive restart. No replay guarantee is claimed across a full process restart. Invalid session/cursor/internal gateway errors reset to Identify; explicit forbidden intent, invalid shard and banned/offline bot close codes stop recovery and report degradation. Reconnect backoff caps at 30 seconds with a configured consecutive attempt budget; stop/AbortSignal cancel timers and the owned socket.

C2C bindings and allowlists use `author.user_openid`. Group bindings use `group_openid`, and group allowlists use `author.member_openid`. `GROUP_AT_MESSAGE_CREATE` content already excludes the platform @robot prefix and is retained verbatim. Bots, attachments and nonzero message_type are diagnosed/ignored without creating text tasks. Stable source identity includes event type, body message ID and the published `message_scene.ext` msg_idx (or msg_seq when present); gateway `s` is never the source ID. The msg_idx distinguishes documented indexed parts. Other scene fields, especially short-lived auth_token, are not persisted.

Durable target data is `{type:"c2c"|"group",msgId,messageAt}` beside the frozen user/group OpenID. Sends use `/v2/users/{openid}/messages` or `/v2/groups/{openid}/messages`, `msg_type:0` and `content`. Chunks use a conservative 2000 UTF-8 byte limit. For each source message, StateStore CAS reserves an immutable msg_seq allocation for each persisted chunk idempotencyKey **before** external send. Simultaneous send calls cannot allocate the same sequence to different chunks, and explicit retry/restart reuses the old allocation. Keys need not be UUIDs. Protocol state stores no credentials and is bounded to 256 chunk allocations per source message.

Published passive limits are C2C 60 minutes and 4 replies per source message; group 5 minutes and 5 replies. The window uses the platform message timestamp, not restart or delayed acceptance time. The C2C autogen field table still says 5 minutes, conflicting with its page summary and current overview; Relanox follows the current 60-minute C2C summary/overview. The remote API can reject earlier and that terminal result is preserved.

When a fresh chunk has exhausted/expired passive permission, the default preserves the result as rejected. Setting `allowProactive:true` explicitly permits that chunk to use proactive sending without msg_id/msg_seq. This also requires platform/account permission and the user's/group's active receiving preference; the plugin cannot grant either. An existing passive allocation never changes to proactive during a retry, avoiding a different external effect after an uncertain send. It likewise does not silently convert an API permission/window rejection to another send. Operators review the preserved result and can explicitly recover it.

`idempotentSend=false` applies to the account because proactive sends have no documented durable deduplication. Passive duplicate responses prove suppression, not a recoverable platform receipt, so `40054005` stays unknown instead of claiming success. HTTP 429 uses bounded Retry-After; documented temporary codes retry; window/permission/format codes reject; unclassified 5xx, malformed responses and broken connections stay unknown. An accepted response's actual `id` becomes platformMessageId.

Sources verified 2026-10-11, using the live July–September 2026 v2 docs rather than older SDK assumptions: [access token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html), [WebSocket and close-code rules](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html), [message overview/windows](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html), [C2C send](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html), [group send](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html), [C2C event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html), [group @ event](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html).

Local protocol tests cover real core/SQLite ingestion, authentication bytes, heartbeat/Resume/replayed messages, durable seq CAS under concurrent calls and SQLite reopen, windows/reply limits, explicit proactive fallback, receipt/error semantics and credential isolation. They do not establish live-account compatibility; account support remains experimental.

Audit recovery coverage: a failed durable dispatch blocks all later dispatches on that socket, so Resume cannot skip the failed message. A new connection retries from the last contiguous successful cursor. Hello heartbeat setup preserves the authentication deadline; heartbeat ACKs alone cannot keep a gateway without READY alive indefinitely. Both regressions use actual sockets, and the cursor test uses a real SQLite INSERT failure.
