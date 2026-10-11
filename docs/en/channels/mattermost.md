# Mattermost

Reception uses native WebSocket posted events; output uses independent REST posts.

Place the following object in the account’s `config`. Account IDs, sender allowlists, agent bindings, secret references and common recovery rules are described in [configuration](../configuration.md). See [agents](../agents.md) for the destination agent.

```json
{
  "serverUrl": "https://mattermost.example.com",
  "botUserId": "dedicated_bot_user_id",
  "token": {
    "env": "MATTERMOST_TOKEN"
  }
}
```

## Setup and delivery

Create a bot account with permission to read and post in the selected channels. Allowlist exact Mattermost user IDs and bind channel IDs; a thread binding uses its root post ID. The WebSocket authenticates through `authentication_challenge` with the token, then decodes the JSON post inside `data.post`. Own posts, empty content and nonstandard/system post types are excluded. Sender identity is the authenticated event's `user_id`.

Delayed output calls `POST /api/v4/posts` with the frozen `channel_id`, message and optional `root_id`. It requires a provider post ID before recording success. Chunks are at most 16,000 Unicode code points. HTTP 429 is retryable; explicit provider 4xx is rejected; ambiguous transport/5xx/malformed success is unknown. `idempotentSend:false`: the relay does not promise durable provider-side deduplication.

Disconnects reconnect with fresh authentication. Stable post IDs deduplicate events that are received again, but Mattermost WebSocket history is not replayed by this integration. Messages occurring while disconnected can be missed; no end-to-end platform replay guarantee is claimed.

`timeoutMs` defaults to 10,000 and `reconnectMs` to 1,000. HTTPS/WSS is required. `allowInsecureLocalhost:true` permits explicit loopback HTTP/WS; embedded URL credentials, query, fragments and HTTP redirects reject. Signal-driven stop closes the active connection and bounded reconnect work.

Targets freeze the server URL and configured bot user ID. Reconfiguring either causes old results to reject instead of silently posting into a different server/account.
