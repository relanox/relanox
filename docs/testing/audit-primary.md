# Primary channel audit test admission

## Terminal core policy rejections (Telegram, Discord, Slack, Feishu)

1. Protect authenticated channels acknowledging `sender_not_allowed` and `unbound_conversation` as deliberate terminal skips, and Discord continuing to the next event and persisting its resume sequence. Unauthorized text must never become an accepted request.
2. Treating every Host.ingest rejection as a storage outage causes needless webhook redelivery and makes Discord repeatedly resume before the same rejected event, blocking later authorized messages.
3. Existing tests cover bot/media filtering and genuine storage failure only; neither exercises the documented core policy error boundary. LINE already handles these outcomes. The host fixture only supplies boundary errors; the plugin decides ACK/cursor behavior. Discord uses real SQLite protocol state.
4. No new production seam: existing ChannelHost.ingest, signed webhook handlers, real WebSocket peer and SQLite storage are used.

## Feishu token acquisition failure before message submission

1. Protect automatic retry when tenant-token acquisition fails transiently, while preserving unknown outcomes after the message API has been contacted.
2. The single send try/catch currently maps token network failures and HTTP 5xx to unknown, requiring manual recovery even though no message request was issued.
3. Existing tests assert unknown for an already-aborted send and only cover successful token issuance; they do not distinguish pre-send authentication from the message effect.
4. No new seam: local HTTP peer records which endpoint was contacted. The canceled-send test will be updated to the pre-send retryable contract; message-response failures keep their existing unknown assertions.

## Audit evidence scope

Review covers Telegram, Discord, Slack, Feishu and LINE production parsing, identity, signatures, durable handoff, sends, limits, lifecycle and recovery. No live accounts. Official sources checked: [Telegram Bot API](https://core.telegram.org/bots/api), [Discord Gateway](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx), [Slack Events](https://docs.slack.dev/apis/events-api/), [Feishu official request handling](https://github.com/larksuite/node-sdk/blob/main/dispatcher/request-handle.ts), [LINE retry contract](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/).
