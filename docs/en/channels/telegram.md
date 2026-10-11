# Telegram

Use HTTPS Bot API message webhooks and independent native text/media output.

Account `config` ([configuration](../configuration.md)):

```json
{
  "botToken": {
    "env": "TELEGRAM_BOT_TOKEN"
  },
  "webhookSecret": {
    "env": "TELEGRAM_WEBHOOK_SECRET"
  }
}
```

## Setup and delivery

Set the bot's webhook externally to `https://your-relay/channels/telegram-main/webhook` with the same `secret_token` and `allowed_updates: ["message"]`. This plugin does not alter existing platform webhook registrations. Set bindings to the exact decimal chat ID, and a decimal topic `threadId` when present. Sender allowlists use `from.id`; incoming messages use identified bot users.

Webhook secrets use constant-time comparison. `update_id` deduplicates deliveries, and successful HTTP 204 follows durable ingestion; failed handoff returns 503. Bot, edited and service events create no task.

Outbound is plain text with previews disabled and optional topic/reply parameters; 4096 codepoints per core chunk. API `ok:false` is checked even on HTTP 200; 429 `retry_after` becomes a durable core retry delay. Network timeouts and ambiguous responses are `unknown`. No durable platform idempotency is claimed.

Optional config: `apiBaseUrl` (default `https://api.telegram.org`) for a local Bot API server or enterprise proxy, `timeoutMs` (100–60000, default 10000), `allowInsecureLoopback` (default false). Cleartext HTTP is permitted only on literal loopback/localhost with explicit opt-in; credentials, fragments and redirects are rejected. Secrets remain environment references in persisted configuration. Bot token format and webhook secret alphabet are checked before use.

## Native media

Photos, audio, voice, video, animation, video notes and documents are downloaded with `getFile` before durable ingestion. The largest photo size is selected; captions remain request text, and media-only messages are accepted. Cloud downloads are bounded to 20 MiB and the configured relay limit.

Generated images, audio, video and files use multipart `sendPhoto`, `sendAudio`/`sendVoice`, `sendVideo` and `sendDocument` with actual stored bytes and the frozen chat/topic/reply. Ogg/Opus uses `sendVoice`; GIF images use `sendAnimation`. Native audio/video duration is preserved in milliseconds and sent as integer seconds. Uploads are bounded to 10 MiB for photos and 50 MiB otherwise, additionally bounded by relay limits. Telegram validates codec, dimensions and platform limits. Media captions are limited to 1,024 codepoints; core sends final text separately so it is not truncated. Ambiguous effects stay held.

See [Media transfer](../media.md) and the official [Bot API](https://core.telegram.org/bots/api#getfile). Local tests verify HTTP and multipart bytes; live account and codec compatibility remain unverified.

## Account changes

Accepted targets freeze the bot ID derived from the token’s numeric prefix and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.
