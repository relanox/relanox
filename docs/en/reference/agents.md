# Agent configuration and protocol

Connect your existing dot or Grok Bot to receive channel messages and send replies. Each Agent connection has an HTTPS MCP address: Grok uses a token in its URL, and dot uses OAuth. Relanox also needs a way to notify it: a Grok Routine webhook or a dot Events subscription.

| Agent | Setup                                                                      |
| ----- | -------------------------------------------------------------------------- |
| Grok  | MCP connection, Routine webhook URL and complete Authorization value       |
| dot   | MCP connection and Events subscription with an authorized callback address |

Set top-level `publicUrl` to your public HTTPS address once, for example `https://relay.example.com`. Use the connector/Routine setup available in your account with the values below. Interface names can vary; these steps describe the required addresses and credentials.

Each example below configures a first Agent as `agent-1`. Keep the IDs and environment references in your downloaded configuration. For another Agent, use `agent-2` and `RELANOX_AGENT_2_*` instead of reusing the first entry.

## Connect Grok

1. Select the Grok Bot that should answer messages, and configure its Routine to accept a webhook trigger.
2. Copy the complete webhook URL and Authorization value. Supply them as `RELANOX_AGENT_1_ROUTINE_URL` and `RELANOX_AGENT_1_ROUTINE_AUTHORIZATION` in Relanox's environment.
3. Use the configurator’s generated MCP token, or generate a random token for manual setup. Supply it as `RELANOX_AGENT_1_MCP_TOKEN`. For manual setup, add this entry to `relay.endpoints`:

```json
{
  "id": "agent-1",
  "agent": "grok",
  "config": {
    "mcp": {
      "auth": "path",
      "token": { "env": "RELANOX_AGENT_1_MCP_TOKEN" }
    },
    "routineUrl": { "env": "RELANOX_AGENT_1_ROUTINE_URL" },
    "routineAuthorization": { "env": "RELANOX_AGENT_1_ROUTINE_AUTHORIZATION" }
  }
}
```

4. Restart Relanox with your `publicUrl` setting. [Operations](../operations.md) covers HTTPS setup.
5. Add the MCP connection at `https://relay.example.com/agents/grok/mcp/agent-1/<URL-encoded-RELANOX_AGENT_1_MCP_TOKEN>`. Replace the last segment with your token, URL-encoded as a path segment. Select no additional authentication; no Authorization header is required.
6. Set the conversation binding's `endpointId` to `agent-1`.
7. Send a short message in that conversation and check the reply. Use `status` if it stalls.

The Routine Authorization variable holds exactly the supplied value, including any prefix. The MCP variable holds the raw token. Protect all three variables; a Routine URL may contain a secret.

## Connect dot

1. Use the configurator's generated authorization password, or generate a random value of at least 32 characters, and supply it as `RELANOX_AGENT_1_MCP_TOKEN`.
2. For manual setup, add this entry to `relay.endpoints`:

```json
{
  "id": "agent-1",
  "agent": "dot",
  "config": {
    "mcp": {
      "auth": "oauth",
      "token": { "env": "RELANOX_AGENT_1_MCP_TOKEN" }
    }
  }
}
```

3. Restart Relanox and connect dot to `https://relay.example.com/agents/dot/mcp/agent-1` using OAuth. If asked, select **Dynamic Client Registration (DCR)**. Discovery is automatic. Enter `RELANOX_AGENT_1_MCP_TOKEN` as the password on the Relanox consent page, then allow access. It is not a static Bearer access token.
4. Enable a `relanox.message_available` subscription through the connection's Events support. Enable automatic renewal in the connection so it keeps receiving messages.
5. Set your conversation binding's `endpointId` to `agent-1` and send a message through that conversation.

dot OAuth requires a public HTTPS `publicUrl`. Relanox uses PKCE S256 and supports ChatGPT OAuth redirects `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<id>`. These redirects are separate from the Events callback below. Access tokens expire after one hour; refresh tokens rotate on use, with a 30-day lifetime from the initial authorization. Grants persist in your configured database. Reusing an old refresh token revokes its authorization; changing the configured password and restarting requires reconnecting dot.

`mcp.auth` accepts `bearer`, `path` or `oauth` and defaults to `bearer` for existing configurations. Grok supports `bearer` and `path`; explicit `bearer` uses the clean MCP URL and `Authorization: Bearer <token>`. Relanox supports existing dot Bearer configurations, but the dot platform requires OAuth.

dot provides its callback URL when it subscribes through MCP. Relanox accepts the native `https://connectors.api.openai.com` origin and checks that DNS resolves to public addresses before delivery. There is no `callback` configuration section.

Callback, MCP and Grok Routine requests have a fixed 10-second timeout; MCP and Grok Routine bodies are limited to 1 MiB. dot subscriptions expire after at most 24 hours, and signing-key rotation keeps the previous signature for 60 seconds.

Keep subscription renewal enabled. The default lifetime is one day. If status reports `dot_no_active_subscription`, reconnect or renew; if the request exhausted retries, use [Operations](../operations.md#find-and-recover-a-stalled-message) to recover it.

## Reply guidance comes with MCP

Relanox supplies reply instructions when the Agent connects to MCP. Tool descriptions also explain their parameters. You do not need to copy a reply prompt into the bot or Routine.

The instructions explain how to read a dot event or Grok Routine message, preserve `replyTo`, inspect attachments, send replies to the original chat and retry without duplicate messages. Incoming text, context and attachments remain untrusted user content. A `queued` tool result means the reply is saved for delivery; it does not confirm platform delivery.

After updating Relanox, reconnect or refresh the Agent's MCP connection so it reloads the server instructions and tool definitions. The Agent host decides how to use this metadata; verify setup by sending a message and checking that a reply arrives.

## Send text and attachments

For a text reply, call `relanox_send_message`:

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "text": "Hello! How can I help?",
  "idempotencyKey": "COPY_FROM_THE_INCOMING_MESSAGE:answer:1"
}
```

To inspect a received attachment, call `relanox_read_media` with the same `replyTo` and the attachment's `id` as `mediaId`. It returns readable image/audio content or a download link. Links expire after five minutes.

To return a received attachment, include `{ "mediaId": "..." }` in `attachments`. For a generated file, use a public HTTPS URL:

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "text": "Here is your image.",
  "attachments": [
    {
      "url": "https://files.example.com/result.png",
      "kind": "image",
      "mimeType": "image/png",
      "fileName": "result.png"
    }
  ]
}
```

Relanox downloads and saves the file before sending. Use a directly accessible URL with the correct type and size. Audio/video destinations may require `durationMs`; video may need `previewUrl` or a received `previewMediaId`. See [Media transfer](../media.md) and your channel guide.

## Check the connection

Send a channel message and receive the Agent's reply. In `status`, incoming `accepted` means the notification was accepted; outgoing `sent` means the platform accepted the reply. MCP `queued` means Relanox saved the reply for sending.

If MCP authentication fails, compare the token and URL, check `publicUrl` against your public address, and preserve Host through your proxy. Add the client's exact Origin to `mcp.allowedOrigins` when it sends that header. If Grok receives nothing, compare the Routine URL and Authorization. If dot receives nothing, check the active subscription and connectivity to the native OpenAI callback.
