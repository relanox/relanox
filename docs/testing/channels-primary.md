# T07 test admission

These tests exercise native protocol boundaries using actual local HTTP/WebSocket peers. They do not claim real-account compatibility. The recording ChannelHost records arguments and controls completion/failure; it does not implement routing, retry, authorization or persistence. Core/storage recovery is covered by the real storage contracts and T12 end-to-end tests.

## Telegram webhook and independent Bot API send

1. Protect raw webhook secret authentication, stable update identity, topic/reply address, persist-before-ACK, independent plain-text sends and documented API errors.
2. A renamed header, accepting a forged token, losing a topic, acknowledging failed ingest, enabling parse modes, or ignoring `ok:false`/`retry_after` would fail.
3. Core tests do not understand Telegram wire headers, integer IDs or Bot API envelopes.
4. No unused production seam: public setup/send APIs and configurable local Bot API server URL are used; the host only records input and returns a controlled receipt.

## Slack HTTP Events and Web API send

1. Protect raw-body HMAC and freshness, URL verification, app/workspace identity, stable event/thread targets, bot suppression and Web API success/error receipts.
2. Signing reserialized JSON, accepting stale requests, flattening threads, accepting another workspace, enabling literal mention parsing, or treating HTTP 200 `ok:false` as sent would fail.
3. Existing core/Telegram tests have no Slack signature/event/response semantics.
4. No: HTTP mode and enterprise API base configuration are production features; peers capture real HTTP bytes.

## Slack Socket Mode lifecycle

1. Protect app-token connection acquisition, socket envelope acknowledgment after ingest, failed-ingest no-ACK, reconnect and bounded stop.
2. ACK before commit, using the bot token to open connections, not handling disconnect or reconnecting after shutdown would fail.
3. HTTP coverage cannot detect socket authentication/envelope/lifecycle regressions.
4. No: Socket Mode is a supported production receive mode; real local sockets drive the public lifecycle methods.

## Discord Gateway and REST

1. Protect identify intents/authentication, bot identity/filtering, heartbeat ACK, durable resume sequence after ingest, reconnect/stop and REST thread-channel send without mass mentions; report real rate limits/unknown transport effects.
2. Wrong identify properties, advancing sequence before ingest, resuming a failed message, forgetting heartbeat, bot loops, malformed REST payload or blanket retry/idempotence would fail.
3. Other channel tests do not implement Discord opcodes/session/nonce-window contracts.
4. No: Gateway/API endpoints are deployment configuration, namespace state is the existing production StateStore. The peer implements only Discord wire responses, and real SQLite state is used for durable resume tests.

## Feishu signed/encrypted HTTP and message API

1. Protect SHA256 signature over raw bytes, AES256-CBC IV-prefix decoding, token/app/tenant authentication, URL challenge, text-content JSON, tenant token expiry and durable chat/thread/reply sends.
2. Wrong IV or key derivation, trusting unsigned or wrong tenant events, routing on ephemeral token, failing token refresh, or encoding content as an object would fail.
3. Existing coverage does not exercise Feishu cryptography, nested event schema or tenant access-token protocol.
4. No: public HTTP setup/send and configured Feishu/Lark base URLs use the same production transport; independent fixtures encrypt/sign payloads and capture requests.

## Configuration and transport bounds (all four)

1. Protect env-reference-only credentials, TLS/local-loopback opt-in, account target scope, bounded payloads and cancelled sends classified unknown.
2. Accepting literal secrets, arbitrary cleartext remote URLs, foreign account targets or silently retrying aborted sends would fail.
3. Core cannot validate platform-specific configs and outbound transport behavior.
4. No: validated production configuration and public send boundaries supply all seams; no test-only injection or routing implementation.
