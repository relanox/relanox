# DingTalk application robot

`@relanox/channel-dingtalk` exports `createDingTalkChannel()`. Reception uses application robot Stream CALLBACK events. Sending uses OAuth OpenAPI single/group robot endpoints, independent of the receive connection and temporary session webhook.

```json
{
  "id": "ding-work",
  "channel": "dingtalk",
  "allowedSenders": ["$:LWCP_v1:opaque-platform-sender-id"],
  "config": {
    "clientId": "application-client-id",
    "clientSecret": { "env": "DINGTALK_APP_SECRET" },
    "robotCode": "application-robot-code",
    "apiBase": "https://api.dingtalk.com",
    "maxReconnectAttempts": 20
  }
}
```

Enable Stream in the application robot configuration, use the matching `robotCode`, and grant the application robot independent single/group message API permissions. Users must be reachable by the application; the robot must belong to the group. External identities without a usable `senderStaffId` are explicitly unsupported. Sender allowlists use the trusted callback's opaque `senderId`, which avoids assuming corporate staff IDs are globally unique. DM bindings use `senderStaffId`; group bindings use `conversationId` (the OpenAPI `openConversationId`). Callbacks with another robot code, own-bot sender or group `isInAtList != true` are ignored.

Connection registration POSTs `/v1.0/gateway/connections/open` with ClientID/ClientSecret and subscription `{type:"CALLBACK",topic:"/v1.0/im/bot/messages/get"}`. The returned ticket is used only to establish that connection and is never persisted/reused. Stream SYSTEM ping echoes the opaque data; WebSocket ping/pong detects dead transports; disconnect and bounded exponential reconnect obtain fresh tickets. Start returns after its bounded initial attempt, and AbortSignal/stop prevent future reconnects. Only the owned account socket is closed.

Stable `data.msgId` is the durable source identity; `headers.messageId` identifies the particular delivery ACK. Text ACK `{code:200,data:"{\"response\":null}"}` is sent after Host.ingest resolves following SQLite/PostgreSQL commit. A failed storage write produces no successful ACK. Unsupported media is diagnosed and gets a non-success callback response, never a processed text task. The protocol can still duplicate callbacks; storage source deduplication remains authoritative.

Durable targets contain staff ID or open conversation ID and no `sessionWebhook`, ticket or access token. OAuth `/v1.0/oauth2/accessToken` credentials resolve at use. Tokens are kept in memory and refreshed before expiry, after explicit auth expiry or SecretRef environment rotation. Single sends POST `/v1.0/robot/oToMessages/batchSend` with one `userIds` entry. Group sends POST `/v1.0/robot/groupMessages/send` with `openConversationId`. Both carry `robotCode`, `msgKey:"sampleText"`, and JSON-encoded `msgParam:{content:...}`, authenticated by `x-acs-dingtalk-access-token`.

Text chunks conservatively use 4000 UTF-8 bytes. `processQueryKey` is retained as a query handle in receipt data; it is not presented as a platform message ID. Invalid staff IDs reject; flow-controlled single recipients and 429 retry with bounded delays; permission failures reject. Missing/malformed acceptance responses, network loss and generic 5xx preserve unknown effects. `idempotentSend=false`; no client-generated send UUID is documented for these APIs.

`apiBase` can select a deployment-approved API domain or proxy. Redirects are refused, TLS verification remains enabled, and only explicit `allowInsecureLoopback:true` permits plain HTTP/WS on loopback for local protocol peers. It cannot permit remote insecure endpoints. Operators should restrict configuration access because the API base receives application credentials.

Sources: [official Stream protocol](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/), [official Node Stream client source](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts), [single-chat OpenAPI](https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches), [group OpenAPI](https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message), and [official independent-send explanation](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/).

Real-account support remains experimental.

Accepted targets also freeze the client ID, robot code and normalized API base URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported. Stored targets without account scope are rejected as `invalid_target`. Restore the original account configuration for identity-mismatch results, then use explicit delivery recovery; legacy unscoped results need operator review and manual delivery rather than automatic rebinding.
