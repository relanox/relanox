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
