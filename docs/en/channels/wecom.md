# WeCom intelligent robot

Use an enabled intelligent robot with one resident process owning its WebSocket connection. Multiple processes displace each other; a replaced connection reports bot_connection_replaced and stops reconnect.

Account `config` ([configuration](../configuration.md)):

```json
{
  "botId": "intelligent-robot-id",
  "secret": {
    "env": "WECOM_BOT_SECRET"
  },
  "wsUrl": "wss://openws.work.weixin.qq.com",
  "heartbeatMs": 30000,
  "maxReconnectAttempts": 20
}
```

## Setup and delivery

`wsUrl` supports the address supplied by a privately deployed enterprise. TLS verification remains enabled. `allowInsecureLoopback: true` permits plain WS only for localhost/127.0.0.1/::1 protocol peers; never use it to downgrade a remote deployment. Credentials resolve from the environment at subscription time, including reconnects, and never enter durable targets or logs.

DM bindings use the sender's `userid`; group bindings use the callback `chatid`. The sender allowlist always uses `from.userid`. Text callbacks are delivered by the authenticated intelligent robot connection, with group messages restricted by the platform to robot interactions. `aibotid` must match the configured bot; own-bot messages are ignored. Deduplication uses body `msgid`, independently of transport `req_id`. Unsupported events create no task and are diagnosed without payload logging.

The persisted reply target contains chat ID, message ID, `chattype` and the nonsecret account/server scope; it never saves `response_url` or a callback request handle. Final text is sent independently with `aibot_send_msg`, using `chatid=userid` for DM and `chatid=chatid` for groups. Relanox escapes Markdown punctuation to retain literal text and conservatively chunks input at 2048 UTF-8 bytes, limiting the escaped send body to 4096 bytes. It does not invoke the temporary stream-reply API.

Subscription, ping and send responses correlate by freshly generated `req_id`. A successful send ACK provides no documented platform message ID, so the receipt stays empty. Socket write, unrelated ACK, connection loss and missing ACK do not imply delivery. Explicit busy/rate-limit responses retry; unknown sends require operator recovery. `idempotentSend=false` because request correlation does not provide durable external deduplication. Start completes after the initial bounded connection/subscription attempt; reconnect delays grow from 1 to 30 seconds and stop after the configured consecutive attempt budget. Heartbeat, protocol request timeout and AbortSignal close the owned connection and stop timers.

Accepted targets also freeze the bot ID and normalized WebSocket URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

`heartbeatMs` accepts 1,000–60,000 and defaults to 30,000. `maxReconnectAttempts` accepts 0–1,000 and defaults to 20.

## Media

Native image/video/file and mixed text/image callbacks download before durable ingestion. Each resource expires after five minutes and uses its own AES-256-CBC key, with PKCS#7 padding to 32-byte multiples. Voice callbacks supply transcription, not audio bytes, so voice input remains text. Download URLs and keys are not persisted as media.

Output uses `aibot_upload_media_init`, 512 KiB base64 chunks and `aibot_upload_media_finish`, then independent `aibot_send_msg` with `media_id`. PNG/JPEG/GIF images and MP4 video are limited to 10 MiB, AMR audio to 2 MiB, ordinary files to 20 MiB. Minimum upload is five bytes; filenames are at most 256 UTF-8 bytes. Captions are separate durable text chunks. Upload failure can retry; ambiguous final sends remain unknown.

`mediaOrigins` optionally lists exact administrator-configured private download origins. Public HTTPS downloads enforce DNS and byte limits and refuse redirects. Loopback HTTP also requires the exact origin and `allowInsecureLoopback:true`. The default core limit is 25 MiB; encrypted downloads allow only the additional padding envelope.

Protocol: [native long connection and media upload](https://developer.work.weixin.qq.com/document/path/101463). Local encrypted HTTP/socket and real SQLite restart tests do not establish live-account compatibility.

[Media transfer](../media.md)
