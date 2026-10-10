# T06 Agent protocol test admission

Before writing each group, the four required admission questions were answered below. Tests use the production SDK, core and real SQLite; local HTTP peers only receive/signature-check submitted traffic and send protocol replies. No live account is claimed.

## MCP tools and authentication, both agents

1. Observable behavior: real MCP clients discover the four strict tools, modern dot and stateless legacy/modern Grok exchange wire requests, authenticated endpoint scope cannot be widened, claim/complete/fail produce durable idempotent business results, and outputs omit internal configuration and reply targets. Host/Origin, unknown fields and oversized streamed bodies are rejected.
2. Credible regression: trusting handler authInfo without checking Bearer; forwarding caller endpoint IDs; returning the full snapshot; marking mutating tools read-only; accidentally using session-only MCP transport; or stripping strict schemas.
3. Gap: core tests call Host methods directly and do not exercise MCP SDK wire negotiation, HTTP authentication or tool envelopes.
4. Unused seam: none. Capture the ChannelHost supplied to a fixture channel's normal setup, use its production ingest API, and use SDK client transport's fetch option (also used for authenticated/custom transport deployments). No production method is added for tests.

### Already-aborted streamed requests, both agents

1. Observable behavior: an authenticated MCP request whose signal is already aborted returns HTTP 408 even when its body producer never yields data.
2. Credible regression: installing only a future abort listener misses an already-fired abort; the pending stream read then never settles.
3. Gap: existing authentication and oversized-body cases use bodies that settle normally and never begin with an aborted signal.
4. Unused seam: none. Exercise the production MCP request guard used by both mounted HTTP handlers with a real Request signal and a stream that represents a stalled client body; the core's separate outer body guard can mask this failure.

## dot subscription lifecycle, callback verification and signed dispatch

1. Observable behavior: discovery advertises top-level Events; verified subscriptions survive SQLite reopen, renew identity/TTL, enforce ownership, sign stable retry events and both keys during rotation, expire/stop without falsely accepting dispatch, and reject bad challenges/callback destinations without storing an active subscription.
2. Credible regression: process-local subscription Map; activating before verifying echo; losing TTL on renewal; signing reserialized bytes; new event IDs on retries; secrets required for unsubscribe; sending to another endpoint; or unrestricted SSRF.
3. Gap: storage tests cover CAS, not application subscription identity, callback protocol, DNS destination policy, key rotation or dispatch selection.
4. Unused seam: none. Explicit loopback HTTP is a documented production option for operator-controlled receivers, restricted to literal loopback and exact configured origin. Production public HTTPS uses connection-time DNS pinning and a conservative global-address policy; address-policy tests protect that public security contract, without injectable DNS/fetch bypasses.

### Delivery classification and subscription ownership cases

1. Observable behavior: retries preserve event IDs/bytes; redirects, 410 and 413 stop automatic delivery; 410 retires only the exact delivered subscription version; callback timeouts remain unknown; another authenticated endpoint cannot remove this endpoint's subscription; expired rotation no longer signs with the old key.
2. Credible regression: generic fetch follows a redirect, a fresh random event ID defeats receiver deduplication, a 410 deletes a concurrent refresh, endpoint route identity is ignored, or old signatures continue indefinitely.
3. Gap: the lifecycle happy path does not exercise rejected/transient callback responses, concurrent renewal or a second authenticated endpoint.
4. Unused seam: none. Local HTTP peers send the specified callback status or deliberately delay/hold a response; persisted state remains real SQLite. Date.now is moved only to test production TTL/rotation rules without sleeping.

## Grok Routine trigger bytes and transport outcomes

1. Observable behavior: supplied URL and complete Authorization are used; Chinese/newlines/request IDs/context are transmitted in a stable content envelope, internal secrets/targets are absent, only HTTP receipt is accepted, transient rejection is retryable and ambiguous network/timeout effects remain unknown. Redirects/permanent/oversized cases reject without following or submitting.
2. Credible regression: inferred vendor endpoint; omitting message text; treating Webhook 2xx as completion; automatic retry after timeout; following redirects with credentials; or reading environment secrets once so rotation fails.
3. Gap: core tests validate generic DispatchResult transitions, not real Routine HTTP bytes, status classification, credential rotation or MCP result return.
4. Unused seam: none. Configured literal loopback transport supports local reverse-proxy/receiver deployments; HTTP peers capture bytes and return statuses, never implement Relanox routing, persistence, retry or authorization.
