# Discord

`@relanox/channel-discord` exports `createDiscordChannel(environment = process.env)`, one instance per account.

```json
{
  "id": "discord-main",
  "channel": "discord",
  "allowedSenders": ["123456789012345678"],
  "config": {
    "botToken": { "env": "DISCORD_BOT_TOKEN" },
    "botUserId": "987654321098765432"
  }
}
```

Enable Message Content intent in the developer portal and grant the bot channel viewing/sending and thread access permissions. Default intents are 37377 (`GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT`). Custom intents must retain the three message/content bits. Bind ordinary channels using their channel ID. Guild thread reception resolves the channel's type/parent via `GET /channels/{id}`; bind the parent channel as `chatId` and thread channel as `threadId`. Outbound sends to the frozen thread when present. DMs use their channel ID.

Transport: Gateway v10 JSON over WSS, REST API v10. Sources: [Gateway](https://docs.discord.com/developers/events/gateway), [Gateway events](https://docs.discord.com/developers/events/gateway-events), [channels](https://docs.discord.com/developers/resources/channel), [messages](https://docs.discord.com/developers/resources/message), [rate limits](https://docs.discord.com/developers/topics/rate-limits).

`start(signal)` schedules connection work and resolves promptly; `stop()` aborts transport and bounds shutdown. Identify/resume, heartbeat/ACK watchdog, reconnect and invalid-session handling are native. READY bot identity must match config. Fatal authentication/intents/sharding close codes degrade the connection and stop automatic reconnect. Session/sequence live in account-scoped durable StateStore; a text dispatch advances the cursor only after successful Host ingestion. Failed handoff closes the connection and retains the earlier cursor. Discord's replay/session expiry limits still apply; no unlimited offline delivery promise is made.

Human default/reply text messages are accepted; bot/webhook/system/nontext messages are diagnosed and skipped. REST sends suppress allowed mentions and reference the original message. Core chunks at 2000 UTF16 units. A stable 24-character nonce with `enforce_nonce` reduces short-window duplicates, but Discord only enforces it for a few minutes, so `idempotentSend` is false. 429 `retry_after` is honored; transport/5xx ambiguity remains `unknown`.

Optional config: `apiBaseUrl` (default `https://discord.com/api/v10`), `gatewayUrl` (default `wss://gateway.discord.gg`), `intents`, `timeoutMs` (default 10000), `reconnectDelayMs` (100–30000, default 5000), `allowInsecureLoopback` (default false). Production custom URLs support enterprise proxies; cleartext is loopback-only with opt-in. HTTP redirects are disallowed, WS payloads/dispatch backlog are bounded.

Real-account support remains experimental. Media, interactions, edits, voice, sharding and multiple concurrent sessions for the same bot are unsupported.

## Frozen sender identity and configuration changes

Accepted targets now preserve the canonical API base URL (including any proxy path) and stable nonsecret bot/application identity. Sends reject `invalid_target` before HTTP if the current configured identity or API base differs. Token/secret rotation under the same bot identity remains supported. Telegram derives the bot ID from the public numeric token prefix; other channels use their configured bot/application IDs, so operators must keep those IDs accurate when replacing credentials.

Targets without the required identity fields are rejected as `invalid_target` and require manual delivery; requeue cannot reconstruct missing identity. For targets rejected after a configuration change, restore the matching original identity/API base before explicit recovery. The plugin never fills missing identity from current settings.

Saved Gateway sessions also bind bot ID, canonical API base and configured Gateway URL. Changing these settings, or loading a session without matching identity fields, starts a new Identify instead of resuming that session.
