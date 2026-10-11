# Hosted Agent audit

Scope: dot Events/MCP and Grok Routine/MCP. Use official SDK clients, production core, real SQLite and local HTTP peers. No real accounts.

## dot in-flight callback versus unsubscribe/recreate

1. Protect a newly verified subscription from a stale 410 response for a prior subscription at the same canonical owner/event/URL identity.
2. A callback captures state version 1, while MCP unsubscribe deletes the row and subscribe recreates version 1. The old callback's conditional delete then removes the new subscription (ABA version reuse).
3. Existing coverage only renews an existing row, which increments version to 2. It never removes and recreates the identity while an HTTP response is outstanding. Extend that coherent case to both renewal and recreation.
4. No new production seam. The official MCP client performs subscribe/unsubscribe; a local HTTP receiver holds the old callback; production SQLite stores state. The storage-level version fix is owned by the root audit workstream.

## dot event acknowledgement without response-body dependency

1. Protect definitive event callback status handling: 2xx acknowledges receipt, 410 retires the delivered subscription, and 5xx remains retryable, even if the response includes an oversized body. Verification must still read and validate its bounded challenge echo.
2. The same HTTP helper currently buffers both challenge and normal event bodies. Its 16 KiB body limit converts known status responses to unknown, incorrectly blocking work or leaving a retired subscription active.
3. Existing status tests send tiny complete bodies; challenge tests correctly require JSON but do not distinguish the body-free event acknowledgement protocol.
4. No test-only seam. The HTTP helper needs separate response handling for its two existing production callers: verification reads the body, event delivery uses status headers. Local peers return status plus a large body; SDK subscription setup and real SQLite remain unchanged.

Primary protocol: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), checked 2026-10-11, specifies the JSON challenge echo and normal event HTTP status acknowledgements separately.

## MCP request metadata on Events methods

1. Protect event discovery, subscription and unsubscribe when a conforming MCP client includes request `_meta` such as a progress token or vendor correlation value. Metadata must not enter subscription identity or authorization.
2. Custom Events parameter schemas are strict and omit `_meta`. The SDK removes only wire envelope keys and forwards other metadata, so valid requests fail with InvalidParams.
3. Existing SDK clients supply only their automatic envelope metadata, which the SDK removes before custom validation. No test sends additional standard/vendor metadata to Events methods.
4. No new seam. Use the official client's real custom request API against the production MCP handler and SQLite subscription store.

Primary source: [MCP general metadata fields](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta), plus installed SDK 2.3.1 `liftWireOnlyMaterial` and custom `setRequestHandler` validation. The SDK preserves non-envelope request metadata for handlers.
