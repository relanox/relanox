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

## Frozen bot and API server identity (all five channels)

1. Protect delayed replies from changing bot/application/server when an operator reuses an account ID with changed configuration. Persist only stable nonsecret IDs and the canonical API base. Credential rotation for the same identity must continue to work; historical targets without this evidence must be refused.
2. Existing sends validate only account/channel and sometimes team/tenant; after restart they can send an old result using a different bot or to the same chat ID on a different API server.
3. Existing target tests cover mismatched supplied account/team/tenant, not a valid formerly accepted target used by a newly configured plugin. Existing wire fixtures will add the frozen identity fields, and rejection tests verify no HTTP effect. LINE exercises actual persisted targets with SQLite; Discord already verifies its received target and real SQLite cursor restart.
4. No new production seam: the existing serializable ReplyTarget.data carries identity and send verifies it before HTTP. Public plugin setup models restart/config changes. Tests do not implement routing, persistence, authorization or retries.

## Discord saved Gateway origin and LINE canonical API base

1. Protect restart using the currently configured Gateway, and LINE sending the same push endpoint after equivalent URL spelling and same-bot credential rotation.
2. Discord reuses a saved resume URL based only on bot ID, so a changed API/Gateway configuration can ingest the old server's events under the new server's target identity. LINE appends `/v2` to a base ending in `/`, producing a double-slash path even though the frozen base is canonical.
3. Existing Discord recovery tests retain all connection settings; existing LINE tests do not rotate credentials or vary trailing slashes. New cases record real connection opcodes/HTTP paths and use real SQLite state for the cached session.
4. No new seams: existing plugin lifecycle, configurable endpoints and production plugin_state storage are used.

## Feishu URL registration challenge authentication

1. Protect webhook URL registration with Feishu's unsigned URL-verification challenge while requiring its configured verification token, and continue requiring signatures/freshness on message events.
2. Requiring event-signature headers before inspecting the decrypted URL challenge blocks initial subscription registration, even with the correct encrypt key and verification token.
3. Existing challenge fixtures always add synthetic signature headers. The official [HTTP adapter](https://github.com/larksuite/node-sdk/blob/main/adaptor/default.ts) invokes [challenge decoding](https://github.com/larksuite/node-sdk/blob/main/adaptor/services/challenge.ts) before the dispatcher's signature check. New cases omit those headers; negative cases prevent unsigned regular events or wrong-token challenges being accepted.
4. No production seam: ordinary Request handlers and AES-encrypted protocol bodies are used. No account is contacted.
