# Enterprise channel implementation audit

Scope: WeCom, DingTalk, QQ, Microsoft Teams and Google Chat. Tests use local HTTP/WebSocket peers and production core/SQLite only; no real accounts.

## OAuth acquisition failures and opaque token lengths (Teams / Google Chat)

1. Observable behavior: a temporary OAuth failure leaves the durable result pending, with no message request emitted; permanent OAuth rejection is rejected; a later healthy token response permits delivery. An opaque access token longer than an entity identifier is forwarded intact.
2. Credible regression: a shared catch labels failures before the message request as unknown, permanently parking unsent results. Reusing the 1024-character identifier schema rejects valid longer OAuth tokens.
3. Existing coverage: peers always issue a short successful token; only message-endpoint status codes are varied.
4. Production seam: none. Extend only the external peer's token response controls. Use the public channel/core APIs and real SQLite state.

## QQ contiguous durable Resume cursor

1. Observable behavior: failure to ingest a dispatch prevents subsequent queued dispatches from moving the Resume cursor past it; after reconnection the peer can replay from the last durable cursor and both text messages are stored.
2. Credible regression: recovering the dispatch promise with an empty catch immediately executes later queued callbacks, allowing a skipped failed message to be acknowledged by a higher sequence.
3. Existing coverage: normal reconnect is tested only after every dispatched message has already succeeded; no failed dispatch followed by buffered events is covered.
4. Production seam: none. A real SQLite trigger rejects one selected inbound INSERT until removed. The socket peer records actual Resume frames and replays external events.

## QQ authentication deadline while heartbeats succeed

1. Observable behavior: a gateway that sends Hello and heartbeat ACKs but never READY must time out and reconnect.
2. Credible regression: installing the heartbeat clears the pending authentication deadline before READY, leaving the channel unauthenticated indefinitely.
3. Existing coverage: the gateway peer always immediately responds READY after Identify.
4. Production seam: none. Use a real WebSocket peer and the production deadline; no timer injection or alternative connection implementation.
