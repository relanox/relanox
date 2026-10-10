# T08 protocol test admission

All cases use production channel factories, a real HTTP/WebSocket external peer and the production core/SQLite host. Peers only capture bytes and return platform protocol responses. No live account is represented by these tests.

## WeCom subscription, inbound identity, delayed Markdown and receipts

1. Observable behavior: subscribe with the environment secret; missing credentials or rejected subscription close the unauthenticated socket; accept DM/group text under the stable body msgid; exclude mismatched bots and media; independently send escaped text to the frozen chatid; correlate ACK by req_id without inventing a platform message ID.
2. Regression: retaining a socket after initial subscription failure, using callback req_id as dedup identity, response_url as the durable address, aibot_respond_msg for delayed results, or any unrelated ACK as successful send would leave conflicting connections or lose/redirect/duplicate work.
3. Coverage gap: core/storage tests cannot check WeCom frame bytes, authentication or callback shape.
4. Seam: no unused production seam. Configured wsUrl serves private enterprise deployments; explicit insecure loopback opt-in is the only local peer transport concession.

## WeCom heartbeat, send ambiguity and abort lifecycle

1. Observable behavior: correlated ping ACK keeps the connection alive; disconnect before send ACK returns unknown; abort removes the connection and prevents reconnect; a platform disconnected_event reports displaced bot ownership and prevents competing reconnects.
2. Regression: treating socket write as delivery success, retaining heartbeat timers after stop, accepting an unrelated ACK or reconnecting after another owner displaced the bot would produce false receipts or conflicting connections.
3. Coverage gap: storage retry cases have no platform socket or timer lifecycle.
4. Seam: no extra seam; heartbeatMs is an operator tuning setting for enterprise endpoints and maxReconnectAttempts bounds reconnection.

## DingTalk Stream credentials, ACK ordering, sender/dedup and long-lived targets

1. Observable behavior: request one-use Stream tickets with CALLBACK subscription; ACK accepted text only after real SQLite acceptance; dedup changing delivery headers by stable msgId; use trustworthy senderId for allowlists and staffId/conversationId for independent sends. Ignore bot loops, unmentioned groups and diagnose media. Core sender_not_allowed/unbound_conversation policy rejections discard without creating tasks or tearing down the account connection.
2. Regression: immediate ACK before storage commit, dedup by headers.messageId, saving sessionWebhook or conflating an allowlist denial with storage failure would lose inputs on restart, make delayed sends expire or let unauthorized traffic continuously reconnect the bot.
3. Coverage gap: the core cannot detect which Stream ID or temporary URL a channel chose.
4. Seam: no unused seam. apiBase selects enterprise/service domains; only explicit loopback permits plain HTTP and WS peers. The test uses the production storage transaction, never a hand-written ACK/routing mock.

## DingTalk token refresh and remote outcomes

1. Observable behavior: OAuth token is refreshed at expiry/rotation; single and group sends have documented OpenAPI bodies; per-staff throttling and 429 are retryable, permission errors terminal, missing response/network uncertainty unknown.
2. Regression: retaining expired credentials or marking flow-controlled users sent falsely advances a persisted chunk.
3. Coverage gap: generic core retry policy cannot identify DingTalk response body semantics.
4. Seam: no extra seam; use real HTTP peer response status/body and environment secret rotation.

## QQ WebSocket identify/resume, heartbeat, indexed text and stop

1. Observable behavior: QQBot access token and GROUP_AND_C2C intent identify the session; accepted cursor advances after persistence; reconnection resumes with that cursor and processes replayed messages before RESUMED; group/C2C use correct OpenIDs; media/bot events create no tasks; abort prevents reconnection.
2. Regression: old Bot token auth, gateway sequence as source event identity, ignoring replay before RESUMED or persisting message_scene auth_token breaks login, dedup, durability or credential isolation.
3. Coverage gap: core/storage do not know QQ opcodes, indexed event identity or session cursor rules.
4. Seam: no unused production seam. apiBase is the configured service/sandbox domain, and explicit loopback is used for the network peer.

## QQ sequence CAS, SQLite reopen, passive limits and explicit proactive fallback

1. Observable behavior: reserve unique sequence numbers before external sends, reuse a chunk's allocation after reopening real SQLite, apply 60-minute/4-reply C2C and 5-minute/5-reply group limits, allow proactive fallback only when configured, preserve ambiguous proactive sends as unknown.
2. Regression: in-memory counters, allocation after HTTP send or treating proactive traffic as idempotent duplicates effects on retry/restart; shared 5-minute C2C rule rejects valid delayed results.
3. Coverage gap: storage CAS coverage proves the primitive, not channel sequence allocation, window choice or actual wire body reuse.
4. Seam: no unused seam. StateStore is the production protocol state API, the storage file is genuinely closed/reopened, and network payload assertions use independently specified sequences/windows.

## QQ explicit errors and transport security/config boundaries

1. Observable behavior: 429 respects bounded Retry-After; permission/window errors reject; documented temporary errors retry; duplicate-effect response and malformed/5xx/network uncertainty stay unknown; static secrets and remote insecure URLs are rejected.
2. Regression: blindly retrying ambiguous sends, mapping QQ HTTP 200 code failures to success, or following a redirect with credentials loses results or leaks credentials.
3. Coverage gap: generic host/config tests do not recognize platform token shapes or QQ business codes.
4. Seam: no extra seam; config validation and actual HTTP status/body are public production inputs.
