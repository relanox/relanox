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

## Frozen account identity and transport destination

1. Observable behavior: after accepting text and reopening SQLite with the same local account ID but a different robot/application or API/WebSocket base, the old target is rejected before any message is sent. Ordinary secret/key rotation for the same identity remains usable. Legacy targets missing the frozen identity are rejected rather than redirected.
2. Credible regression: the send adapter resolves only the current account config, so account IDs reused for another bot or deployment redirect older accepted work.
3. Existing coverage: targets preserve conversation/thread IDs, but tests never reopen the same account with another bot/server. The Chinese protocol tests manually construct old target data and must now include the same nonsecret scope that ingress freezes; their existing protocol assertions stay intact. Teams' exact target assertion gains app ID, and Google Chat's original ingress fixture remains unchanged.
4. Production seam: none. Native ingress creates targets in real SQLite, then fresh plugin/core instances read the same database. External peers only acknowledge native protocol requests. Teams/Google Chat use the existing signed HTTP peers; their old target is exercised against a separately assembled account after credential/config changes.

## Review evidence

- WeCom: checked the official WecomTeam SDK command/message schemas and existing real WS regressions. Subscribe, request correlation, DM/group address selection, independent Markdown send, escaping/UTF-8 bounds, unknown send handling and replacement-connection stop remain covered. Added account/server scope and reopened-database refusal/secret-rotation proof.
- DingTalk: checked the official Stream protocol/client and current OpenAPI documentation links. Existing real HTTP/WS tests protect OAuth headers, stable body IDs versus delivery ACK IDs, successful ACK after SQLite commit, no ACK after a failed write, single/group API bodies and non-idempotent failure mapping. Added account/server scope and reopened-database refusal/secret-rotation proof.
- QQ: inspected gateway control/data concurrency, token acquisition, passive windows, per-chunk durable CAS sequence reservations and restart behavior. Real SQLite-trigger failure reproduced Resume skipping sequence 2 and sending cursor 3; repair preserves cursor 1 until replay. A live heartbeat-only gateway reproduced missing authentication timeout. Existing window/reply-limit/unknown-effect tests remain unchanged apart from required frozen target scope.
- Teams: verified official JWT/OAuth/endorsement requirements and inspected conversation-reference service-origin validation. OAuth failures and the arbitrary token-length cap reproduced at real HTTP peers, then passed after repair. Frozen app identity now complements the existing bot/tenant/service URL checks.
- Google Chat: verified HTTP interaction caller identity and app-authenticated create-message/thread docs. OAuth acquisition now distinguishes definitely-unsent failures from unknown message effects. Frozen service-account email/server survives SQLite reopen, and a fresh private key for the same service account remains valid.

No real account credentials or platform accounts were used. WebSocket session cursors remain process-local where documented; these tests prove local durability/protocol behavior, not platform replay or live-account compatibility. Targets predating frozen identity are intentionally not automatically rebound.

## Teams removed service-origin trust

1. Observable behavior: a target whose frozen service origin is no longer trusted is rejected before OAuth/message traffic, and restoring trust permits sending.
2. Credible regression: URL trust validation throws outside the send error boundary, causing core to classify a definitely-unsent configuration refusal as unknown.
3. Existing coverage: incoming untrusted service URLs are tested, but a once-valid persisted target after trust configuration changes is not.
4. Production seam: none; extend the existing SQLite-reopen case with a different trustedServiceOrigins configuration and inspect actual peer traffic.
