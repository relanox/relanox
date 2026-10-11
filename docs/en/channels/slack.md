# Slack

Use a Slack workspace app with HTTP Events or Socket Mode reception and independent bot-token output.

Account `config` ([configuration](../configuration.md)):

```json
{
  "receiveMode": "http",
  "botToken": {
    "env": "SLACK_BOT_TOKEN"
  },
  "signingSecret": {
    "env": "SLACK_SIGNING_SECRET"
  },
  "botUserId": "UBOT123",
  "teamId": "T123ABC",
  "appId": "A123ABC"
}
```

## Setup and delivery

HTTP Events request URL is `https://your-relay/channels/slack-main/events`. For Socket Mode replace `receiveMode` with `"socket"`, remove `signingSecret`, add `appToken: {"env":"SLACK_APP_TOKEN"}`, enable Socket Mode and grant the app token `connections:write`. The bot token independently needs `chat:write` and appropriate message history/event subscriptions. Subscribe to the required `message.channels/groups/im/mpim` or `app_mention` events. Bind exact channel/thread IDs: a root message starts a result thread at its `ts`, and a threaded message preserves `thread_ts`.

HTTP authenticates the exact raw bytes with HMAC-SHA256 and a five-minute timestamp bound before challenge/ingest. App/workspace identities must match. Source identity is `event_id`. Socket Mode obtains its WSS URL using the app token, checks bounded typed envelopes and ACKs only after Host ingestion. Failed handoff closes without ACK; unsupported envelopes are acknowledged with the inbound-rejected counter with `error_class=unsupported`. Disconnect refresh reconnects; ping/pong detects dead connections. Public start returns promptly and stop aborts bounded connection work.

Bot, integration, message subtype/edit and nontext events are skipped. Sending uses the bot's `chat.postMessage`, frozen channel/thread, `mrkdwn:false`, `parse:none`, and disabled unfurls. Text control characters `&<>` are escaped according to [Slack formatting rules](https://docs.slack.dev/messaging/formatting-message-text/) so literal text cannot activate mention/link syntax. Text is split at 4000 codepoints. HTTP 200 `ok:false` is an error; 429 Retry-After becomes retryable, ambiguous transport/internal failures stay unknown. No durable external idempotency or ephemeral response URL is used.

Optional config: `apiBaseUrl` (default `https://slack.com/api`), `timeoutMs` (default 10000), `reconnectDelayMs` (100–30000, default 1000), `allowInsecureLoopback` (default false). Custom API endpoints support enterprise proxies. Cleartext HTTP/WS is allowed only on loopback with explicit opt-in. Persisted target contains the workspace ID, never tokens/socket URLs.

## Account changes

Accepted targets freeze the workspace, application, bot user and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.
