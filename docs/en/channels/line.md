# LINE Messaging API

Use a LINE Messaging API Official Account with signed HTTP webhooks and independent push output.

Account `config` ([configuration](../configuration.md)):

Create a LINE Official Account with a Messaging API channel, obtain its channel secret and access token, enable Webhooks and optionally webhook redelivery. Set the webhook URL to `/channels/<accountId>/webhook` on the public HTTPS listener. The bot must be a friend of the user or a member of the addressed group/room and have the relevant push permissions/quota.

```json
{
  "botUserId": "U_your_bot_destination",
  "channelSecret": {
    "env": "LINE_CHANNEL_SECRET"
  },
  "accessToken": {
    "env": "LINE_ACCESS_TOKEN"
  }
}
```

## Setup and delivery

`botUserId` must match the webhook `destination`. Sender allowlists contain the source `userId`; bind `chatId` to the user, group or room destination. LINE has no native text thread address. Source `webhookEventId` is the durable deduplication key. Text is limited to 5,000 UTF-16 units per chunk. Anonymous events without an attributable sender, reply-token sends, cards and other interactive events are outside this integration.

Incoming requests require the original bytes' HMAC-SHA256 `X-Line-Signature`. Relanox verifies the configured destination and waits for durable ingest before ACK. Known allowlist/unbound exclusions are diagnosed and ACKed; unexpected persistence failures return an error. The frozen target stores only the source destination/type/message reference; credentials and `replyToken` are never persisted.

Independent output uses `POST /v2/bot/message/push` with the current environment-backed token. Each persisted chunk gets a random UUID retry key saved atomically in protocol state before network IO. Retries and explicit recovery reuse that key; `409` with `X-Line-Accepted-Request-Id` confirms prior acceptance. The retry key's provider validity is 24 hours from its first attempt. After that conservative local deadline sends become unknown and require operator handling; the plugin declares `idempotentSend:false` so a lease expiry never blindly replays a finite-window effect. A 429 is retryable, a definitive 4xx is rejected, and a transport error/5xx is unknown. Acceptance is not proof the user read or received the message.

Optional `apiBase` (default `https://api.line.me`) supports an explicitly authorized gateway. `allowLoopback:true` permits HTTP only for loopback peers; HTTPS and redirect rejection remain the default. Configuration is strict and credentials require `{env}` references.

## Native media

Image/audio/video/file inputs use authenticated content downloads from `contentApiBase` (default `https://api-data.line.me`); external-provider content is downloaded without the LINE token. Both pure media and native text events are accepted. Original bytes and supplied audio/video duration are stored before acknowledgement.

Native outbound image/audio/video messages require the global public media publisher; see [Media transfer](../media.md). LINE fetches opaque public URLs without agent claim credentials. Images must be JPEG/PNG at most 10 MB; previews must be JPEG/PNG at most 1 MB. Images within the preview limit reuse their original URL; larger images and every video require an explicit staged `previewMediaId`. Video must be MP4; audio must be MP3/M4A with positive `durationMs`. Video/audio are capped at 200 MB and relay limits. Core sends final text separately; push requests reuse durable retry keys.

LINE has no native generic file message for outbound Messaging API sends. File input is supported, but file output is rejected and is not advertised as a native capability. Media is not converted or replaced with a URL text placeholder. Optional `contentApiBase` supports an administrator-configured gateway under the same transport policy as `apiBase`.

The official [message objects](https://developers.line.biz/en/reference/messaging-api/index.html.md) define these limits. Local tests verify signed ingress and native URL-fetch bytes; live account playback, reachability and quota remain unverified.

## Account changes

Accepted targets freeze the bot user and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.
