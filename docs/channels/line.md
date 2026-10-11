# LINE Messaging API

`@relanox/channel-line` exports `createLineChannel()`. One instance serves one configured Messaging API account. Native HTTP webhook reception and independent push messages are implemented; real accounts remain experimental and were not tested.

Create a LINE Official Account with a Messaging API channel, obtain its channel secret and access token, enable Webhooks and optionally webhook redelivery. Set the webhook URL to `/channels/<accountId>/webhook` on the public HTTPS listener. The bot must be a friend of the user or a member of the addressed group/room and have the relevant push permissions/quota.

```json
{
  "botUserId": "U_your_bot_destination",
  "channelSecret": { "env": "LINE_CHANNEL_SECRET" },
  "accessToken": { "env": "LINE_ACCESS_TOKEN" }
}
```

`botUserId` must match the webhook `destination`. Sender allowlists contain the source `userId`; bind `chatId` to the user, group or room destination. LINE has no native text thread address. Source `webhookEventId` is the durable deduplication key. Text is limited to 5,000 UTF-16 units per chunk. Media, anonymous events without an attributable sender, reply-token sends, cards and other interactive events are outside this implementation.

Incoming requests require the original bytes' HMAC-SHA256 `X-Line-Signature`. Relanox verifies the configured destination and waits for durable ingest before ACK. Known allowlist/unbound exclusions are diagnosed and ACKed; unexpected persistence failures return an error. The frozen target stores only the source destination/type/message reference; credentials and `replyToken` are never persisted.

Independent output uses `POST /v2/bot/message/push` with the current environment-backed token. Each persisted chunk gets a random UUID retry key saved atomically in protocol state before network IO. Retries and explicit recovery reuse that key; `409` with `X-Line-Accepted-Request-Id` confirms prior acceptance. The retry key's provider validity is 24 hours from its first attempt. After that conservative local deadline sends become unknown and require operator handling; the plugin declares `idempotentSend:false` so a lease expiry never blindly replays a finite-window effect. A 429 is retryable, a definitive 4xx is rejected, and a transport error/5xx is unknown. Acceptance is not proof the user read or received the message.

Optional `apiBase` (default `https://api.line.me`) supports an explicitly authorized gateway. `allowLoopback:true` permits HTTP only for loopback peers; HTTPS and redirect rejection remain the default. Configuration is strict and credentials require `{env}` references.

Verified protocol sources: [signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/), [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/), [finite retry-key window](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/). Local Vitest tests use HTTP peers, real core/SQLite, signed webhook bytes and restart recovery; they do not validate a live LINE account.

## Frozen sender identity and configuration changes

Accepted targets now preserve the canonical API base URL (including any proxy path) and stable nonsecret bot/application identity. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported. Telegram derives the bot ID from the public numeric token prefix; other channels use their configured bot/application IDs, so operators must keep those IDs accurate when replacing credentials.

Upgrade boundary: older persisted targets without these identity fields are refused as `invalid_target`; requeue alone cannot add missing historical evidence. Drain pending work with the original version before upgrading, or retain the result for manual delivery under the verified original account. For new targets rejected after a configuration change, restore the matching original identity/API base before explicit recovery. The plugin never fills missing historical identity from current settings.
