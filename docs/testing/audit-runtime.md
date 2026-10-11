# Runtime audit test admission

## Durable agent-kind authorization

1. Protect the original snapshot's agent kind when an endpoint ID is reassigned: list filters before its limit, foreign claims (including replay) fail, and foreign completion/failure cannot mutate a claimed request even with its token. Real SQLite and PostgreSQL run the same contract.
2. Checking only endpoint IDs lets a newly configured Grok principal read and take a Dot request. Filtering only after the SQL limit hides valid requests behind older foreign rows; checking scope after replay leaks claim tokens.
3. Existing endpoint-scope tests use different IDs and never retain an old snapshot under a reused ID. Existing FIFO and completion tests retain the same agent kind throughout.
4. No test-only production seam. The required agent field belongs to the storage API used by authenticated core hosts; real storage owns authorization and transactions.

## Core principal propagation and early completion authorization

1. Protect propagation of the host's authenticated agent kind into list, claim, complete, and failure storage calls, and reject completion of a foreign-kind snapshot before channel lookup or output preparation.
2. Omitting the agent scope or deriving it from the request being completed grants another agent's authority; checking only the current endpoint ID also reaches delivery preparation for an unauthorized request.
3. Existing host tests verify endpoint ID intersection only. Storage contracts cannot verify the core derives the agent from its host.
4. No unused production seam. Recording storage captures only IO arguments; it does not implement authorization, retries, or persistence.

## Required scope field in existing storage callers

1. Existing storage, CLI startup, IRC, and Signal assertions continue protecting their documented persistence/protocol behavior while naming the actual caller's agent kind.
2. An incorrect scope now returns no request or refuses mutation, exposing caller wiring mistakes.
3. These are mechanical adaptations of existing coverage to the required storage contract, not additional redundant tests.
4. No additional seam or fake behavior is introduced.

## Connection failure diagnostics

1. Protect the SDK connection callback's diagnostic code and recovery outcome reaching the configured observability plugin with the registered plugin identity.
2. Accepting only the status argument silently discards authentication/network failure reasons, leaving an unhealthy connection metric without a diagnostic log.
3. Channel protocol tests use their own callback recorders and observability sanitization tests supply logs directly; neither crosses the core host boundary.
4. No new production seam. The test observes the existing public connection callback and observability log API. Standard observability remains responsible for finite vocabulary filtering.

## Audit coverage and evidence

The second runtime audit reviewed all production source files in `packages/sdk/src`, `packages/core/src`, `apps/cli/src`, `plugins/storage-sqlite/src`, and `plugins/storage-postgres/src`: SDK schemas and authority boundaries; static config and JSON freezing; chunk limits; telemetry isolation; authenticated host scoping; ingest/claim/complete/failure; dispatch/send deadlines and lease settlement; FIFO/retry/unknown recovery; database initialization, redaction, state CAS, and SQL pagination; CLI validation, native plugin assembly, management listeners, startup rollback, worker drain, and bounded shutdown.

Confirmed corrections are durable snapshot agent authorization and the dropped connection diagnostic. The snapshot regression failed against both real stores (the older Dot request appeared in a Grok page) and core propagation failed without the trusted host agent. All three passed after correction. The connection regression failed because no diagnostic log reached the observer, then passed after forwarding the registered plugin, outcome, and error code.

The independent review of prerequisite `e116dde` (local cherry-pick `28d1f80`) found no correctness issue: deleted plugin state retains a monotonic version in an outer JSON-null tombstone, distinct from a live entry whose user value is null. SQLite's immediate transaction serializes delete/recreate. PostgreSQL runs the read/write sequence at SERIALIZABLE, retries serialization/deadlock failures, and fences writes by the observed version. Tombstones remain excluded from reads and pagination. Idempotent schema initialization preserves existing request and state records.

Validation: full workspace build, format, type-aware lint, and typecheck passed; 91 tests passed across core, both real storage backends, CLI, IRC, Signal, and local protocol E2E after the authority fix. The connection diagnostic change additionally passed all 30 core and standard-observability tests and the full formatting/lint/typecheck gates. Tests use local peers and PostgreSQL 16; no real-account validation was performed. The root integration run is authoritative for the combined branch.
