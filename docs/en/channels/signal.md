# Signal through signal-cli

This integration requires a separately installed, registered and maintained unofficial signal-cli HTTP JSON-RPC/SSE daemon. Signal has no official Bot API here. Relanox does not install the daemon, register a number or manage its account/encryption/session storage.

Account `config` ([configuration](../configuration.md)):

```json
{
  "serviceUrl": "https://signal-bridge.example.com",
  "account": "+15551234567",
  "selfUuid": "the_registered_accounts_uuid",
  "authorization": {
    "env": "SIGNAL_BRIDGE_AUTHORIZATION"
  }
}
```

## Setup and delivery

`authorization` is optional and supplies the complete Authorization header to a trusted reverse proxy. The native daemon itself does not supply this authentication boundary; keep it on a private interface and put authentication/TLS in front of remote access. For a loopback daemon, explicitly set `allowInsecureLocalhost:true` and an HTTP loopback `serviceUrl`.

Reception uses `/api/v1/events?account=<account>`. SSE `receive` data contains `{envelope,account?}`; sender identity prefers `sourceUuid`, then number/source. Configure exact allowlist IDs accordingly. Direct chat bindings use `direct:<sender>` and group bindings use `group:<groupId>`. `selfUuid` is recommended so the account's own UUID messages are reliably excluded. Images, audio, video and files are accepted as attachments, including messages without text. View-once, receipt/typing and self messages are excluded.

The SSE ID is saved after durable ingest and supplied as `Last-Event-ID` on reconnect. signal-cli's event buffer is bounded and in memory; restart or a long outage can lose upstream history. Unknown cursor IDs replay only what the daemon still retains. Storage deduplicates stable envelope identities; this is not an unlimited durable upstream queue. Streams reconnect periodically and shutdown cancels active reads.

Delayed send uses `POST /api/v1/rpc`, JSON-RPC method `send`, with configured account, message and either a recipient array or group ID. Success requires a matching RPC ID and result timestamp; when recipient results are supplied, every result must be `SUCCESS`. Partial group failures remain unknown for operator recovery because automatically retrying the group can duplicate successful recipients. Timestamp-only responses remain compatible with older daemon versions. Chunks are at most 16,000 UTF-8 bytes. `idempotentSend:false`; ambiguous sends remain unknown. Relanox's database backup does not include signal-cli's external account/session state.

`timeoutMs` defaults to 10,000, `reconnectMs` to 1,000. Remote URLs require HTTPS and reject embedded credentials, query, fragments and redirects.

Targets freeze the bridge URL and configured Signal account as well as the recipient/group. Old results reject after those account coordinates change; they are not redirected to another bridge/account.

## Native media

Attachment metadata comes from the authenticated daemon event. Relanox calls native JSON-RPC `getAttachment` with the configured account, attachment ID and original sender or group ID, validates its `{data}` base64 result and enforces both encoded-response and decoded-byte limits. The daemon must already have downloaded the attachment; missing or oversized data does not advance the SSE cursor. Arbitrary URLs and daemon filesystem paths are never used as relay downloads.

Output uses native `send` attachments as RFC 2397 data URIs with MIME, filename and complete bytes. Images, audio, video and files use the same native attachment contract. Relanox buffers and persists media. Native Signal limits and the daemon's external attachment retention still apply. Local SSE/JSON-RPC/SQLite/MCP tests verify byte relay and group addressing.

Protocol sources: [signal-cli manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc#getattachment), [JSON-RPC manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc).

[Media transfer](../media.md)
