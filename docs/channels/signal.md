# Signal through signal-cli

`@relanox/channel-signal` exports `createSignalChannel()`. **Signal has no official Bot API here.** This plugin requires a separately installed, registered and maintained unofficial signal-cli daemon exposing its HTTP JSON-RPC and SSE interfaces. Relanox does not install signal-cli, register a phone number or manage its encryption/session storage.

```json
{
  "serviceUrl": "https://signal-bridge.example.com",
  "account": "+15551234567",
  "selfUuid": "the_registered_accounts_uuid",
  "authorization": { "env": "SIGNAL_BRIDGE_AUTHORIZATION" }
}
```

`authorization` is optional and supplies the complete Authorization header to a trusted reverse proxy. The native daemon itself does not supply this authentication boundary; keep it on a private interface and put authentication/TLS in front of remote access. For a loopback daemon, explicitly set `allowInsecureLocalhost:true` and an HTTP loopback `serviceUrl`.

Reception uses `/api/v1/events?account=<account>`. SSE `receive` data contains `{envelope,account?}`; sender identity prefers `sourceUuid`, then number/source. Configure exact allowlist IDs accordingly. Direct chat bindings use `direct:<sender>` and group bindings use `group:<groupId>`. `selfUuid` is recommended so the account's own UUID messages are reliably excluded. Non-text, view-once, receipt/typing and self messages do not create text work.

The SSE ID is saved after durable ingest and supplied as `Last-Event-ID` on reconnect. signal-cli's event buffer is bounded and in memory (the verified implementation retains 1,000 events); restart or a long outage can lose upstream history. Unknown cursor IDs replay only what the daemon still retains. Core deduplicates stable envelope identities; this is not an unlimited durable upstream queue. Streams reconnect periodically and shutdown cancels active reads.

Delayed send uses `POST /api/v1/rpc`, JSON-RPC method `send`, with configured account, message and either a recipient array or group ID. Success requires a matching RPC ID and result timestamp. Chunks are at most 16,000 UTF-8 bytes. `idempotentSend:false`; ambiguous sends remain unknown. Relanox's database backup does not include signal-cli's external account/session state.

`timeoutMs` defaults to 10,000, `reconnectMs` to 1,000. Remote URLs require HTTPS and reject embedded credentials, query, fragments and redirects.

Sources: [signal-cli JSON-RPC manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc), [HTTP/SSE implementation](https://github.com/AsamK/signal-cli/tree/master/src/main/java/org/asamk/signal/http). Local real-storage SSE/RPC tests do not establish live Signal compatibility; it remains experimental and unofficial.

Targets freeze the bridge URL and configured Signal account as well as the recipient/group. Old results reject after those account coordinates change; they are not redirected to another bridge/account.
