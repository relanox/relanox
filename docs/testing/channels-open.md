# T10 test admission: Matrix, Mattermost, Signal, IRC

The tests use real Node HTTP/WebSocket/SSE/TCP peers and the production core and SQLite plugin. The peers serialize platform frames and record traffic only. A small test agent delegates authenticated claim/completion to the SDK host and forwards dispatch over HTTP; it owns no Relanox routing, authorization, persistence, retry or state machine. No test-only production injection or exported testing seam is introduced. Every transport is configured through its operator-facing server/base URL and explicit loopback plaintext option. Real accounts are excluded and remain experimental.

## Matrix sync, targets and delayed send

1. Protect text ingest, room/thread/reply identity, own-event suppression, sender allowlist rejection, encrypted diagnostics, committed sync cursor, same transaction path on duplicate sends, conservative non-idempotent recovery capability, and immutable delayed targets through scoped claim/completion and outbound.
2. A sync implementation that saves `next_batch` before ingest, uses thread reply ID as the root, sends plaintext into a room that became encrypted, changes transaction keys, or treats self/encrypted events as ordinary input fails.
3. Core/storage tests do not execute Matrix HTTP endpoints, sync schema or Matrix relation bodies.
4. No. The production HTTP base URL and namespaced state are used as designed.

## Matrix storage failure, restart and limited timeline

1. Protect replay after a real SQLite failure and reload of the last committed `since`; detect a limited timeline instead of silently advancing through missing events.
2. Saving a cursor after a failed ingest, ignoring `limited`, or storing the cursor only in process memory fails.
3. Existing storage contracts cannot detect ordering between a homeserver response, ingest and protocol cursor writes.
4. No. Public storage close/reopen and plugin lifecycle reproduce recovery; no storage mock implements the expected behavior.

## HTTP send error boundaries and configuration

1. Protect environment-backed secrets, trusted static HTTPS destinations, loopback opt-in, explicit 429 delay, permanent 4xx rejection and ambiguous transport/5xx outcome.
2. A redirect-following client, inline secret schema, automatic retry of an uncertain POST, or discarded rate-limit delay fails.
3. Core tests consume declared outcomes but do not validate their platform mapping or actual request headers.
4. No. Real local HTTP responses and public `validateConfig`/`send` APIs suffice.

## Mattermost WebSocket and REST

1. Protect the authentication challenge/response, refusal of unauthenticated posted frames, nested post JSON validation, stable post dedup, own-post suppression, threaded delayed REST posts and bounded shutdown/reconnect.
2. Marking a socket connected before auth, ingesting before auth, failing to parse the JSON string, dropping `root_id`, or accepting bot echoes fails.
3. Matrix/Signal tests and core authorization tests cannot cover Mattermost wire frames or REST payloads.
4. No. The production server URL controls both WebSocket and REST paths.

## Signal SSE and JSON-RPC

1. Protect the unofficial signal-cli envelope schema, streaming SSE chunk/multiline framing, account and self filtering, distinct direct/group targets, sender+message timestamp dedup, committed Last-Event-ID across restart and asynchronous independent send.
2. Treating SSE as JSON-RPC notifications, advancing an ID before ingest, merging two senders with the same timestamp, mixing accounts, or using an inbound reply token fails.
3. Other channels do not exercise signal-cli envelope and SSE framing. Storage tests do not drive Last-Event-ID HTTP headers.
4. No. Only operator-facing service configuration, lifecycle and real SQLite are used.

## Signal ambiguous RPC outcomes

1. Protect mismatched JSON-RPC response IDs, declared RPC errors and unknown POST effects from automatic retry.
2. Accepting any `timestamp` regardless of the echoed ID or mapping a generic RPC send error to retryable fails.
3. Generic HTTP error tests do not distinguish HTTP-200 JSON-RPC result/error semantics.
4. No. The external HTTP peer controls only its own response.

## Signal storage failure and cursor ordering

1. Protect Last-Event-ID from advancing when a valid input cannot commit to real SQLite, and recover the same event after reopening storage.
2. Writing the cursor before ingest or swallowing an unknown storage failure as a policy rejection causes the next connection to skip input.
3. Malformed SSE coverage stops at JSON parsing; it does not execute valid ingest followed by a failing database operation.
4. No. The public storage lifecycle closes the actual database after the stream opens; there is no substituted storage implementation.

## Frozen transport origins for all four channels

1. Protect previously accepted reply targets against account server or bot identity reconfiguration. Sending an old frozen target with a different configured origin must reject before network effects.
2. Reading only current channel config during send redirects a stored reply to a different server/account even though core correctly preserved its target.
3. Core snapshot tests do not know platform server/bot addressing; basic send tests keep config unchanged.
4. No. Public channel setup/send and real external peers use static production configuration; only nonsecret origin identifiers enter frozen target data.

## Bounded lifecycle

1. Protect prompt start and aborting active HTTP/SSE/socket connections during stop; bounded stop remains safe if an outstanding storage operation stalls.
2. Awaiting a perpetual receive loop from start or leaving fetch/socket/timer handles running after stop hangs resident shutdown.
3. Endpoint send tests do not exercise a live stream or connection during shutdown.
4. No. AbortSignal and public start/stop are production lifecycle contracts. The tests verify live local connections close, without creating an unused cancellation seam.

## IRC authentication, identity and wire safety

1. Protect TLS default and explicit loopback plaintext, CAP/SASL PLAIN negotiation, registration/JOIN, PING/PONG, account-tag sender identity, server-time/msgid dedup, channel/direct reply targets, own NICK updates, and bounded lifecycle.
2. JOIN before successful registration, ingested server/bot text, spoofable nickname authorization when account-tag is required, ignored PING, or lost private targets fails.
3. Other plugins use HTTP/WS and cannot protect IRC command/tag parsing or authentication sequencing.
4. No. Real TCP peers drive the actual socket implementation; production TLS/auth config provides the necessary seam.

## IRC byte limits, injection and recovery

1. Protect 512-byte UTF-8 wire size including target overhead, CRLF/NUL injection rejection, declared socket-write-only receipt, no false external idempotency, and explicit nick fallback warnings.
2. Counting UTF-16 characters, omitting target overhead, interpolating raw CRLF, or claiming a server delivery receipt from `write` fails.
3. Core chunking tests do not know IRC wire overhead and cannot validate raw socket bytes or receipt strength.
4. No. Public send, configured targets and actual peer traffic suffice.
