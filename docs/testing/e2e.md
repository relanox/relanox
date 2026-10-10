# Resident relay protocol E2E admission

This suite uses `apps/cli/src/runtime.ts` to start the same production Node listeners, native Telegram/Grok plugins, durable worker and real SQLite file used by `run`. External peers only record HTTP bytes and supply platform responses; they do not implement Relanox bindings, authorization, persistence, retries, claims or recovery. MCP uses the official `@modelcontextprotocol/client` 2.3.1 over real TCP without a custom fetch adapter. All account compatibility remains experimental; these tests do not validate real accounts.

## Full ingress, dispatch, authenticated endpoint isolation and outbound

1. An authenticated Telegram event is committed and deduplicated, its exact Unicode text/context reaches the configured Grok Routine, a credential scoped to another endpoint cannot list/claim/complete it, and its authorized MCP final reaches Telegram with the original chat/topic/reply address. Replaying the final produces one durable delivery and no second external send.
2. Node Request adaptation can lose bytes/headers, CLI factory maps can assemble mismatched plugins, a missing principal intersection can expose another endpoint, or the final delivery can lose the frozen reply target across worker/plugin boundaries.
3. Existing core/agent/channel tests use their own assembly or call core fetch directly. CLI ingress tests end at persistence. They cannot prove the complete native HTTP → Routine → official network MCP → worker → native send chain or its security boundary.
4. No new production seam is required. The normal runtime, core administrative read API and documented loopback protocol options are used; peer responses implement only external API behavior.

## Claimed restart and changed binding

1. A claimed request survives a full runtime stop/start against the same SQLite file, remains owned by its original endpoint despite a changed binding, is not redispatched, and completes through its existing claim token to the original reply target. A new event follows the new binding.
2. Rebuilding in-memory queues or deriving old scope from current bindings can rerun claimed remote work, orphan valid claims, or redirect old results during restart.
3. Storage reopen tests do not recreate CLI listeners, native plugin instances and their endpoint protocol routes; plugin tests with a fake channel cannot prove preserved production reply addresses and new binding behavior together.
4. No unused seam. Restart recreates the production runtime, and assertions read actual persisted records and external traffic.

## Unknown external send and explicit delivery recovery

1. A Telegram peer that receives the send body and loses its response leaves an unknown delivery held across restart. Exact-version recovery requires explicit acknowledgement, sends the saved final again to the frozen destination, and never reruns the agent or creates another result.
2. A network exception incorrectly classified retryable, startup selecting unknown records, or recovering the request instead of its delivery can duplicate external effects automatically or rerun already completed agent work.
3. Storage union tests prove conditional updates but not the actual native transport classification, resident worker supervision, shutdown/restart persistence and guarded recovery composed into one pipeline.
4. No unused seam. The external HTTP connection is deliberately dropped after recording its bytes, then the public core administrative recovery API acts on the real database.
