# IRC

`@relanox/channel-irc` exports `createIrcChannel()`. It uses a resident TLS connection with native IRC registration, capability negotiation, PING/PONG, channel/private PRIVMSG reception and independent text output.

```json
{
  "server": "irc.example.com",
  "port": 6697,
  "tls": true,
  "nick": "relanox",
  "channels": ["#support"],
  "sasl": {
    "username": "relanox",
    "password": { "env": "IRC_SASL_PASSWORD" }
  }
}
```

Server `password:{env:...}` is a separate optional PASS credential. SASL PLAIN is required to succeed when configured; it is carried over TLS. Registration negotiates CAP LS 302, account-tag, server-time and message-tags where available, then joins configured channels after welcome. CTCP, commands and bot-authored echoes are excluded.

By default, messages need an authenticated account tag. Allowlist `account:<account-name>`. Binding chat IDs are the configured channel spelling or `dm:<RFC1459-folded-sender-nick>` for private messages. If a network lacks account tags, `allowNickFallback:true` explicitly permits `nick:<folded-nick>` identities and emits a warning. Nickname identity and a delayed private reply address can change ownership; use account-tag-capable networks and understand that IRC does not provide a stable account-addressed DM API here.

A server `msgid` is used for event identity when available. Without it, each received line gets a local unique ID, so reconnect/replay deduplication cannot be guaranteed. Reconnect does not backfill channel history. Threaded replies and edits are not supported.

The plugin limits text chunks to 400 UTF-8 bytes and targets to 90 bytes, preserving the IRC 512-byte line limit including CRLF. CR/LF injection is rejected. A successful send receipt means only `acknowledgement:socket_write`; it does not prove server acceptance or recipient delivery. Disconnect/transport ambiguity stays unknown, and `idempotentSend:false` prevents automatic assumptions of safe replay.

`timeoutMs` defaults to 10,000 and `reconnectMs` to 1,000. TLS is on by default, with normal certificate verification. Plain TCP requires both a loopback server and `allowInsecureLocalhost:true`; there is no option to disable remote certificate checks.

Sources: [modern IRC protocol](https://modern.ircdocs.horse/) and [IRCv3 specifications](https://ircv3.net/irc/). Local TCP peers test protocol bytes and persistence; real networks/accounts remain experimental.

Targets freeze the server, port and TLS mode together with the recipient. Reconfiguring the connection does not redirect old results to another network; a mismatch rejects the send.
