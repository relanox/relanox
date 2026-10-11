# Discord

Reception uses Gateway v10 JSON over WSS; output uses REST API v10.

Account `config` ([configuration](../configuration.md)):

```json
{
  "botToken": {
    "env": "DISCORD_BOT_TOKEN"
  },
  "botUserId": "987654321098765432"
}
```

## Setup and delivery

Enable Message Content intent in the developer portal and grant the bot channel viewing/sending and thread access permissions. Default intents are 37377 (`GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT`). Custom intents must retain the three message/content bits. Bind ordinary channels using their channel ID. Guild thread reception resolves the channel's type/parent via `GET /channels/{id}`; bind the parent channel as `chatId` and thread channel as `threadId`. Outbound sends to the frozen thread when present. DMs use their channel ID.

Transport: Gateway v10 JSON over WSS, REST API v10. Sources: [Gateway](https://docs.discord.com/developers/events/gateway), [Gateway events](https://docs.discord.com/developers/events/gateway-events), [channels](https://docs.discord.com/developers/resources/channel), [messages](https://docs.discord.com/developers/resources/message), [rate limits](https://docs.discord.com/developers/topics/rate-limits).

Identify/resume, heartbeat/ACK watchdog, reconnect and invalid-session handling are native. READY bot identity must match config. Fatal authentication/intents/sharding close codes degrade the connection and stop automatic reconnect. Session/sequence live in account-scoped durable storage; a text dispatch advances the cursor only after durable ingestion. Failed handoff closes the connection and retains the earlier cursor. Discord's replay/session expiry limits still apply; no unlimited offline delivery promise is made.

Human default/reply text and attachment messages are accepted; bot/webhook/system messages are diagnosed and skipped. REST sends suppress allowed mentions and reference the original message. Text is split at 2000 UTF16 units. A stable 24-character nonce with `enforce_nonce` reduces short-window duplicates, but Discord only enforces it for a few minutes, so `idempotentSend` is false. 429 `retry_after` is honored; transport/5xx ambiguity remains `unknown`.

Optional config: `apiBaseUrl` (default `https://discord.com/api/v10`), `gatewayUrl` (default `wss://gateway.discord.gg`), `intents`, `timeoutMs` (default 10000), `reconnectDelayMs` (100–30000, default 5000), `allowInsecureLoopback` (default false). Production custom URLs support enterprise proxies; cleartext is loopback-only with opt-in. HTTP redirects are disallowed, WS payloads/dispatch backlog are bounded.

## Native media

The Gateway accepts attachment-only messages and text with attachments. `MESSAGE_CONTENT` is needed for attachment fields as well as text; grant `ATTACH_FILES` for output. Downloads use bounded public HTTPS CDN URLs without the bot token. URLs are not persisted as the attachment: core stores the original bytes.

Generated images/audio/video/files use Create Message multipart `payload_json` and `files[0]`, retaining the frozen channel/thread, reply, mention suppression and nonce. The plugin uses a conservative 10 MiB upload cap, additionally bounded by relay limits. Guild tier limits and supported codecs still apply. An ambiguous multipart send remains unknown rather than being automatically replayed.

See [Media transfer](../media.md) and Discord's [message API](https://docs.discord.com/developers/resources/message#create-message). Local Gateway/REST tests verify byte transport.

## Account changes

Accepted targets freeze the bot user and canonical API base URL. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported.

Saved Gateway sessions also bind bot ID, canonical API base and configured Gateway URL. Changing these settings, or loading a session without matching identity fields, starts a new Identify instead of resuming that session.
