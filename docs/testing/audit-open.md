# Open channel implementation audit

Scope: Matrix, Mattermost, Signal, IRC and WhatsApp. Local HTTP/socket peers and production core/SQLite only; no real accounts.

## Signal recipient send results

1. Protect the persisted delivery outcome when signal-cli returns a matching JSON-RPC ID and timestamp but a group recipient failed. Partial delivery must remain unknown and must not automatically resend successful recipients. An all-success result still completes.
2. The adapter currently discards the `results` array; a group with one SUCCESS and one NETWORK_FAILURE is incorrectly marked sent. The same applies to other upstream failure types.
3. Existing tests cover top-level RPC errors, mismatched IDs and timestamp-only success, never recipient-level results inside a successful RPC response.
4. No new production seam. Real HTTP returns the upstream result shape; the production core, plugin and SQLite store perform dispatch, completion and delivery transitions.

Primary sources checked 2026-10-11: signal-cli [send result serialization](https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/util/SendMessageResultUtils.java) and [recipient result types](https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/json/JsonSendMessageResult.java). The JSON output contains both timestamp and results; mixed group outcomes can avoid a top-level error.

## Matrix encryption preflight recovery

1. Protect safe automatic retry when the encryption-state GET fails before any message PUT has been issued. After the state endpoint recovers, a normal unencrypted send succeeds.
2. The shared send catch and generic HTTP mapping currently mark both state GET 503 and state connection loss as unknown, leaving ordinary transient read failures in manual recovery.
3. Existing error tests return 404 from the state endpoint and fail only the message PUT; they correctly protect ambiguous sends but cannot distinguish preflight reads.
4. No new seam. A real HTTP peer drops or rejects the state read and records whether any PUT was sent; the existing production plugin/core/SQLite harness is used.

## IRC multiline text serialization

1. Protect delivery of ordinary multiline agent answers as a single PRIVMSG per persisted chunk. CR/LF become spaces; command-like text after a linebreak stays literal message content. UTF-8 wire bounds and NUL rejection remain enforced.
2. Current serialization rejects every linebreak, so lists and paragraphs from an agent are permanently rejected even though safely encoding them needs no extra send or state.
3. Existing coverage treats a CRLF-bearing answer only as an injection attempt and expects rejection. Update that assertion to require one safe line and add multiline content to the existing full core roundtrip, retaining its channel/private routing assertions and byte-limit checks.
4. No new seam. Existing TCP peer records complete CRLF-framed wire commands; production core/storage still persist one chunk and one receipt. No untracked per-line sends are introduced.

## Review evidence and limits

| Channel    | Reviewed contracts and local evidence                                                                                                                                                                            | Outcome / remaining platform limit                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matrix     | Bearer authentication, event and relation schemas, room/thread identity, encrypted-room exclusion, checkpoint after durable ingest, restart replay, 16,000 UTF-8 byte chunks, ambiguous PUT handling             | Fixed safe read preflight retries. Existing limited-timeline refusal remains explicit; no history backfill or E2EE.                                                             |
| Mattermost | Auth challenge/OK gate, nested post schema, self/policy exclusion, channel/root IDs, reconnect dedup, independent REST posts, 16,000 code-point chunks, unknown after dropped POST                               | No additional confirmed defect in this review. WebSocket events missed while disconnected are not backfilled.                                                                   |
| Signal     | Account-filtered authenticated proxy SSE, envelope identities, durable event cursor/restart replay, RPC ID matching, direct/group addresses, 16,000 UTF-8 byte chunks                                            | Fixed partial recipient failures. Upstream SSE replay is bounded and daemon-memory-only; no real Signal account or external daemon state recovery was tested.                   |
| IRC        | TLS policy, SASL PLAIN/capabilities, authenticated account tags, channel/private identity, PING/reconnect, msgid dedup, 400 UTF-8 byte chunks and 512-byte wire bounds                                           | Fixed normal multiline output. Socket write remains weaker than server acceptance; nick-based private destinations can change ownership, and no history replay is promised.     |
| WhatsApp   | Exact-byte HMAC and GET challenge, business/phone validation, customer target, durable 24-hour window refresh, storage-before-ACK control flow, 4,096 UTF-16 unit chunks, independent Graph send and HTTP errors | Existing local protocol suite passes. Meta documentation returned HTTP 429 during this audit, so no new provider error-code classification was asserted from secondary sources. |

Primary references additionally checked: [Matrix client-server specification](https://spec.matrix.org/v1.15/client-server-api/), [Mattermost post model](https://github.com/mattermost/mattermost/blob/master/server/public/model/post.go), [IRC account-tag specification](https://ircv3.net/specs/extensions/account-tag), [signal-cli HTTP handler](https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/http/HttpServerHandler.java) and [SSE buffer](https://github.com/AsamK/signal-cli/blob/master/src/main/java/org/asamk/signal/http/SseEventBuffer.java).

Regression evidence: the original code failed five partial-Signal cases, both Matrix preflight cases, and both updated IRC cases. After the fixes, all 47 tests across the five channel scopes pass. Frozen-lockfile install, workspace build, format, typecheck and type-aware lint were run. No real-account validation was performed.
