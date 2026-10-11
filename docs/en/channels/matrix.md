# Matrix

Reception uses native Client-Server `/sync`; output uses room message APIs.

Account `config` ([configuration](../configuration.md)):

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

Create a dedicated account/device and invite it into the configured rooms. Allowlist exact sender MXIDs such as `@alice:example.com`; bind `chatId` to the room ID. Thread bindings use the original `m.thread` root event ID. The plugin ignores its own events and accepts `m.text`, `m.image`, `m.audio`, `m.video` and `m.file`. Replies preserve the room, thread and original event relation.

Use unencrypted rooms with native message events.

Each send first reads the room encryption state. Transient failures of that read are safely retryable because no message has been issued. Transport or server failures after the message PUT remain unknown and require explicit recovery.

The sync cursor is persisted with compare-and-set only after all received events have been handed off durably or explicitly excluded. Replayed event IDs deduplicate in core storage. If an existing cursor receives a limited timeline, the plugin reports a history gap and refuses to advance; it does not implement history backfill. Resolve the gap operationally rather than assuming missing events were processed.

Outbound `PUT /rooms/<room>/send/m.room.message/<transactionId>` reuses the persisted chunk identity. Matrix transaction deduplication is scoped to the same device and endpoint; a new login/device can lose that scope. The plugin therefore declares `idempotentSend:false`: a SecretRef can be rotated to a new device, so unknown sends require explicit recovery. Known safe retries still reuse the same transaction ID.

Text chunks are at most 16,000 UTF-8 bytes. `timeoutMs` defaults to 10,000, `syncTimeoutMs` to 30,000 and `reconnectMs` to 1,000. Sync calls allow the long-poll interval plus request timeout. HTTPS is required; `allowInsecureLocalhost:true` permits HTTP only for an explicit loopback homeserver/proxy. URLs reject embedded credentials, query and fragments; redirects are not followed.

The reply target also freezes the homeserver and configured user identity. If the account is reconfigured to another server or user, old results are rejected instead of being redirected; restore the original account configuration to deliver them.

## Native media

Images, audio, video and files are downloaded through the authenticated `/_matrix/client/v1/media/download/<server>/<mediaId>` endpoint of the configured homeserver. An `mxc://` server name is a media identifier, never a credential-bearing download destination. Downloads reject redirects and enforce the core byte limit. Use unencrypted attachments.

Outgoing assets use `POST /_matrix/media/v3/upload` and native `m.image`, `m.audio`, `m.video` or `m.file` room events. Filenames, MIME types, sizes and optional duration are preserved; an explicit request-owned image preview becomes `thumbnail_url` and `thumbnail_info`. Core sends queued assets in order after text. Upload or send ambiguity follows the existing unknown-send recovery policy. Media is buffered and durably stored. Homeserver upload limits can be lower than the core limit. Local HTTP/SQLite/MCP tests verify these protocol contracts.

Protocol source: [Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/).

Media uploads finish before the recipient message is submitted. Upload transport errors, invalid upload responses and server failures are retryable; explicit client rejection remains rejected and rate limits honor retry delay. The subsequent message send retains its normal ambiguity handling. When a native media event supplies a separate `filename`, a different `body` is preserved as its caption alongside the stored attachment.

[Media transfer](../media.md)
