# Telegram

Use HTTPS Bot API text webhooks and independent sendMessage output.

Place the following object in the account’s `config`. Account IDs, sender allowlists, agent bindings, secret references and common recovery rules are described in [configuration](../configuration.md). See [agents](../agents.md) for the destination agent.

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

Set the bot's webhook externally to `https://your-relay/channels/telegram-main/webhook` with the same `secret_token` and `allowed_updates: ["message"]`. This plugin does not alter existing platform webhook registrations. Set bindings to the exact decimal chat ID, and a decimal topic `threadId` when present. Sender allowlists use `from.id`; anonymous/channel posts are unsupported.

Outbound is plain text with previews disabled and optional topic/reply parameters; 4096 codepoints per core chunk. API `ok:false` is checked even on HTTP 200; 429 `retry_after` becomes a durable core retry delay. Network timeouts and ambiguous responses are `unknown`. No durable platform idempotency is claimed.

Optional config: `apiBaseUrl` (default `https://api.telegram.org`) for a local Bot API server or enterprise proxy, `timeoutMs` (100–60000, default 10000), `allowInsecureLoopback` (default false). Cleartext HTTP is permitted only on literal loopback/localhost with explicit opt-in; credentials, fragments and redirects are rejected. Secrets remain environment references in persisted configuration. Bot token format and webhook secret alphabet are checked before use.

## Account changes

Accepted targets freeze the bot ID derived from the token’s numeric prefix and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.

For unknown deliveries or targets lacking frozen account identity, follow the [configuration recovery rules](../configuration.md).

Webhook secrets use constant-time comparison. `update_id` deduplicates deliveries, and successful HTTP 204 follows durable ingestion; failed handoff returns 503. Nontext, bot, edited and service events create no task.
