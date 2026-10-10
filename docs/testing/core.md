# Core test admission

These tests protect core-owned decisions. Recording Storage calls does not implement transactions, FIFO, deduplication, claim/final semantics or restart recovery; those require real SQLite/PostgreSQL contract and integration suites in T03/T05/T12.

## Static configuration and secrets

1. Protect rejection of ambiguous bindings/identities and empty sender allowlists, all fifteen channel identifiers, and explicit environment-only secret resolution.
2. Removing referential/uniqueness checks can silently route a conversation to another endpoint; interpolating secrets during config parsing can persist credentials.
3. SDK compilation cannot detect invalid runtime JSON and no storage test validates static config.
4. No unused production seam: validateConfig and resolveSecretRef are CLI/plugin APIs.

## Unicode chunk boundaries (one parameterized group)

1. Protect exact text preservation with each channel length unit, byte/UTF16 ceilings, and malformed text rejection.
2. String slicing splits surrogate pairs; counting codepoints for a UTF8 channel can exceed its wire limit.
3. Platform protocol tests see only their own limits and storage persists chunks without generating them.
4. No unused production seam: complete calls chunkText before the atomic final/outbound write.

## Scoped hosts, immutable handoff and HTTP namespace

1. Protect account/channel mismatch rejection, account/binding sender intersection, authenticated endpoint intersection, frozen original SecretRefs/options, local ingest trace-context persistence, exact HTTP bytes with bounded bodies, and namespace route isolation.
2. Trusting a channel-provided account or tool-provided endpoint scope can cross accounts; sharing plugin-mutated configs can redirect old requests or leak resolved credentials. Trusting Content-Length permits oversized chunked inputs; decoding/reencoding bytes can invalidate signatures; dropping local span context breaks durable correlation.
3. Storage knows endpoint scope but does not authenticate plugin principals or resolve bindings; protocol authentication alone does not test core handoff.
4. No unused production seam: plugins receive these hosts during real setup. A recording IO stub captures the durable write request only; it makes no business decisions.

## Validate before setup

1. Protect rejection of invalid per-endpoint config before any plugin setup accepts traffic, and ensure endpoint validation never substitutes agent-wide setup config.
2. Validating lazily on first dispatch can ACK messages before discovering malformed destination/auth config.
3. Schema unit tests do not run plugin validators; channel protocol tests do not cover factory ordering.
4. No unused production seam: createCore validates before production setup.

## Worker policy and observer isolation

1. Protect forwarding exact lease fences, finite retry budgets and delay bounds, unknown timeout classification, persisted chunk identity, and bounded batch behavior when observers throw.
2. Dropping lease/version permits stale settlement, unbounded retryAfter bypasses retry budgets, exceptions become blind resend, or exporter errors stop messaging.
3. Storage tests enforce fences but cannot check which fence core passes or core transport timeout/retry policy; observability tests isolate its own exporter but not core callers.
4. No unused production seam: public processDue and production WorkerOptions. Recording IO returns a fixed persisted due record and captures settlement; it does not decide lease/state/FIFO/retry transitions. Vitest fake timers control the native timeout, not a test-only clock.

## Aborted inbound streams (before adding the regression)

1. Protect public core.fetch: an already-aborted request or abort during an unfinished body read returns 408 promptly and cancels its reader, without waiting for the global body timeout or calling storage.
2. A listener installed only after an abort, or ignoring request.signal while awaiting reader.read(), leaves disconnected clients consuming a full timeout budget.
3. Existing body-size/timeout cases cover oversized and slow live clients; plugin guards cannot observe a body still blocked in the outer core guard.
4. No new production seam. The existing Core API accepts actual Request/ReadableStream/AbortSignal objects; recording storage throws for every unexpected call. Virtual time checks a 100ms cancellation budget against the configured 1000ms ordinary timeout.
