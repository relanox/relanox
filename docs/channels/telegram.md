# Telegram

`@relanox/channel-telegram` exports `createTelegramChannel(environment = process.env)`. Create one instance per account; core calls `validateConfig` and `setup(host, account, config)`.

```json
{
  "id": "telegram-main",
  "channel": "telegram",
  "allowedSenders": ["123456789"],
  "config": {
    "botToken": { "env": "TELEGRAM_BOT_TOKEN" },
    "webhookSecret": { "env": "TELEGRAM_WEBHOOK_SECRET" }
  }
}
```

Set the bot's webhook externally to `https://your-relay/channels/telegram-main/webhook` with the same `secret_token` and `allowed_updates: ["message"]`. This plugin does not alter existing platform webhook registrations. Set bindings to the exact decimal chat ID, and a decimal topic `threadId` when present. Sender allowlists use `from.id`; anonymous/channel posts are outside this baseline.

Transport: HTTPS Bot API text Webhook and independent `sendMessage`, based on [Bot API 10.3](https://core.telegram.org/bots/api), checked 2026-10-11. Authentication uses constant-time secret comparison. `update_id` is the stable source event key; source `message_id` remains the reply reference. Host ingestion completes before HTTP 204. Failed handoff returns 503. Unsupported nontext/bot/edited/service events are acknowledged with no task and the inbound-rejected counter with `error_class=unsupported`.

Outbound is plain text with previews disabled and optional topic/reply parameters; 4096 codepoints per core chunk. API `ok:false` is checked even on HTTP 200; 429 `retry_after` becomes a durable core retry delay. Network timeouts and ambiguous responses are `unknown`. No durable platform idempotency is claimed.

Optional config: `apiBaseUrl` (default `https://api.telegram.org`) for a local Bot API server or enterprise proxy, `timeoutMs` (100–60000, default 10000), `allowInsecureLoopback` (default false). Cleartext HTTP is permitted only on literal loopback/localhost with explicit opt-in; credentials, fragments and redirects are rejected. Secrets remain environment references in persisted configuration. Bot token format and webhook secret alphabet are checked before use.

Local protocol tests cover authentication, topic/reply, ACK ordering, wire bytes, errors and config boundaries. Real-account support is experimental; no live account was validated. Media, guest/business messages, rich text, edits and ephemeral replies are unsupported.

## Frozen sender identity and configuration changes

Accepted targets now preserve the canonical API base URL (including any proxy path) and stable nonsecret bot/application identity. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported. Telegram derives the bot ID from the public numeric token prefix; other channels use their configured bot/application IDs, so operators must keep those IDs accurate when replacing credentials.

Upgrade boundary: older persisted targets without these identity fields are refused as `invalid_target`; requeue alone cannot add missing historical evidence. Drain pending work with the original version before upgrading, or retain the result for manual delivery under the verified original account. For new targets rejected after a configuration change, restore the matching original identity/API base before explicit recovery. The plugin never fills missing historical identity from current settings.
