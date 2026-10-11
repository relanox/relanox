# Matrix

Reception uses native Client-Server `/sync`; output uses room message APIs.

Place the following object in the account’s `config`. Account IDs, sender allowlists, agent bindings, secret references and common recovery rules are described in [configuration](../configuration.md). See [agents](../agents.md) for the destination agent.

```json
{
  "homeserver": "https://matrix.example.com",
  "userId": "@relay:example.com",
  "accessToken": {
    "env": "MATRIX_ACCESS_TOKEN"
  }
}
```

## Setup and delivery

Create a dedicated account/device and invite it into the configured rooms. Allowlist exact sender MXIDs such as `@alice:example.com`; bind `chatId` to the room ID. Thread bindings use the original `m.thread` root event ID. The plugin ignores its own events and accepts `m.text`. Replies preserve the room, thread and original event relation.

**Encrypted rooms are unsupported.** Encrypted events are explicitly diagnosed; the relay does not decrypt, manage room keys or silently convert them to text. Edits and other relation types, media and membership actions are not relayed.

Each send first reads the room encryption state. Transient failures of that read are safely retryable because no message has been issued. Transport or server failures after the message PUT remain unknown and require explicit recovery.

The sync cursor is persisted with compare-and-set only after all received events have been handed off durably or explicitly excluded. Replayed event IDs deduplicate in core storage. If an existing cursor receives a limited timeline, the plugin reports a history gap and refuses to advance; it does not implement history backfill. Resolve the gap operationally rather than assuming missing events were processed.

Outbound `PUT /rooms/<room>/send/m.room.message/<transactionId>` reuses the persisted chunk identity. Matrix transaction deduplication is scoped to the same device and endpoint; a new login/device can lose that scope. The plugin therefore declares `idempotentSend:false`: a SecretRef can be rotated to a new device, so unknown sends require explicit recovery. Known safe retries still reuse the same transaction ID.

Text chunks are at most 16,000 UTF-8 bytes. `timeoutMs` defaults to 10,000, `syncTimeoutMs` to 30,000 and `reconnectMs` to 1,000. Sync calls allow the long-poll interval plus request timeout. HTTPS is required; `allowInsecureLocalhost:true` permits HTTP only for an explicit loopback homeserver/proxy. URLs reject embedded credentials, query and fragments; redirects are not followed.

The reply target also freezes the homeserver and configured user identity. If the account is reconfigured to another server or user, old results are rejected instead of being redirected; restore the original account configuration to deliver them.
