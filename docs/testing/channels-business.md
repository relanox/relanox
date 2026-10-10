# T09 native business channel test admission

All tests use public plugin APIs, the production core and real SQLite. HTTP peers provide only provider protocol responses and record network traffic. No real account validation is claimed.

## Signed LINE and WhatsApp ingress and delayed sends

1. Protect exact-byte HMAC authentication, stable-event deduplication, account identity, durable ingest-before-ACK, frozen destinations, independent push/text requests, customer windows (including non-text customer activity), malformed authenticated JSON and LINE retry-key persistence.
2. Re-serializing before HMAC, acknowledging failed storage, accepting another phone/bot, using an ephemeral reply token or allocating a new retry key after restart could lose, spoof or duplicate messages.
3. Existing core/storage tests do not run these provider schemas, signatures or wire requests.
4. No new test-only production seam: explicit API base/loopback opt-in supports authorized gateways; SDK Host/state and core APIs are normal production seams.

## Teams and Google Chat JWT and OAuth protocols

1. Protect RS256 signature, issuer, audience and caller identity, trusted Teams service origin/tenant/bot/channel endorsement, frozen conversation/thread addressing and actual OAuth requests.
2. A valid token for another application, unverified JSON sender, attacker service URL, wrong tenant or lost thread could impersonate users or disclose bot credentials; malformed OAuth/provider responses could claim an unsent message.
3. Existing coverage does not exercise either JWT identity boundary or these OAuth and message APIs.
4. Explicit trusted JWKS URLs and API/token endpoints are operator configuration for sovereign networks/proxies; loopback opt-in retains cryptographic verification with real generated keys and local peers.

## Provider error, policy and configuration contracts

1. Protect explicit 429 retry delays, definitive denials, unknown ambiguous effects, malformed input, media/self-bot filtering and strict SecretRef configuration.
2. Treating a timeout/5xx as effect-free, acknowledging arbitrary ingest errors or silently accepting raw credentials could duplicate messages, lose tasks or persist secrets.
3. Core handles normalized outcomes; it cannot verify provider error classification or channel configuration.
4. No private hooks or synthetic storage state machines are introduced. Peers only emit independently specified HTTP status and JSON.

## Verification evidence

- 33 channel protocol tests pass: LINE 7, WhatsApp 6, Google Chat 11, Teams 9.
- Full default Vitest: 78 passed, 21 PostgreSQL tests skipped because the external PostgreSQL test URL is absent in this task worktree. Existing PostgreSQL integration remains root-owned.
- Workspace build, source/test typecheck, Oxfmt and type-aware Oxlint pass without rule suppression.
- LINE closes/reopens actual on-disk SQLite and reuses the UUID on a provider 409; other paths use real SQLite transactions and the production core's ingest/dispatch/claim/complete/outbound flow.
- Test agent supplies only the SDK's external dispatch acceptance and a trusted local principal; core and storage own routing, claims, final completion, persistence and retries. Provider peers supply only HTTP/JWKS/OAuth responses and record sent bytes.
- No real account or live service compatibility was tested.
