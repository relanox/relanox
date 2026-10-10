# WeCom intelligent robot

`@relanox/channel-wecom` exports `createWeComChannel()`. The receive transport is the intelligent robot WebSocket protocol. It requires an enabled intelligent robot, its bot ID and Secret, and one resident process owning its connection. Multiple processes using the same robot displace each other. A `disconnected_event` reports `bot_connection_replaced` and stops automatic reconnection so two instances do not fight for ownership.

```json
{
  "id": "wecom-work",
  "channel": "wecom",
  "allowedSenders": ["staff-userid"],
  "config": {
    "botId": "intelligent-robot-id",
    "secret": { "env": "WECOM_BOT_SECRET" },
    "wsUrl": "wss://openws.work.weixin.qq.com",
    "heartbeatMs": 30000,
    "maxReconnectAttempts": 20
  }
}
```

`wsUrl` supports the address supplied by a privately deployed enterprise. TLS verification remains enabled. `allowInsecureLoopback: true` permits plain WS only for localhost/127.0.0.1/::1 protocol peers; never use it to downgrade a remote deployment. Credentials resolve from the environment at subscription time, including reconnects, and never enter durable targets or logs.

DM bindings use the sender's `userid`; group bindings use the callback `chatid`. The sender allowlist always uses `from.userid`. Text callbacks are delivered by the authenticated intelligent robot connection, with group messages restricted by the platform to robot interactions. `aibotid` must match the configured bot; own-bot messages are ignored. Deduplication uses body `msgid`, independently of transport `req_id`. Unsupported media/events create no text task and are diagnosed without payload logging.

The persisted reply target contains only chat ID, message ID and `chattype`; it never saves `response_url` or a callback request handle. Final text is sent independently with `aibot_send_msg`, using `chatid=userid` for DM and `chatid=chatid` for groups. The current official SDK supports Markdown for this independent path. Relanox escapes Markdown punctuation to retain literal text and conservatively chunks input at 2048 UTF-8 bytes, limiting the escaped send body to 4096 bytes. It does not invoke the temporary stream-reply API. There is no undocumented `chat_type` field on the outgoing body.

Subscription, ping and send responses correlate by freshly generated `req_id`. A successful send ACK provides no documented platform message ID, so the receipt stays empty. Socket write, unrelated ACK, connection loss and missing ACK do not imply delivery. Explicit busy/rate-limit responses retry; unknown sends require operator recovery. `idempotentSend=false` because request correlation does not provide durable external deduplication. Start completes after the initial bounded connection/subscription attempt; reconnect delays grow from 1 to 30 seconds and stop after the configured consecutive attempt budget. Heartbeat, protocol request timeout and AbortSignal close the owned connection and stop timers.

Protocol sources verified 2026-10-11: [intelligent robot long connection specification](https://developer.work.weixin.qq.com/document/path/101463), [official WecomTeam SDK](https://github.com/WecomTeam/aibot-node-sdk), SDK v1.0.6 at commit `80615b987ef69c6028ad764924609247c0725955`, especially `src/types/api.ts`, `src/types/message.ts`, `src/types/event.ts`, `src/client.ts` and [independent-send documentation](https://github.com/WecomTeam/aibot-node-sdk#sendmessage-详细说明). The official document viewer did not expose a readable body in this environment; the typed official SDK source and live official README provide the implemented wire definitions. No SDK or reference clone is a runtime dependency; the implementation is original and uses ws/Zod.

Local protocol tests cover authentication, stable inbound IDs, durable DM/group addresses, literal Markdown wire bytes, heartbeat correlation, uncertain-send preservation, insecure config rejection and stop behavior with real SQLite/core. Real-account validation is excluded from this delivery; account compatibility remains experimental.
