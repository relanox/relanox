# Agent configuration and protocol

Connect your existing dot or Grok Bot to receive channel messages and send replies. Each Agent connection has an HTTPS MCP address: Grok uses a token in its URL, and dot uses OAuth. Relanox also needs a way to notify it: a Grok Routine webhook or a dot Events subscription.

| Agent | Setup                                                                      |
| ----- | -------------------------------------------------------------------------- |
| Grok  | MCP connection, Routine webhook URL and complete Authorization value       |
| dot   | MCP connection and Events subscription with an authorized callback address |

Set top-level `publicUrl` to your public HTTPS address once, for example `https://relay.example.com`. Use the connector/Routine setup available in your account with the values below. Interface names can vary; these steps describe the required addresses and credentials.

Each example below configures a first Agent as `agent-1`. Keep the IDs and environment references in your downloaded configuration. For another Agent, use `agent-2` and `RELANOX_AGENT_2_*` instead of reusing the first entry.

## Connect Grok

1. Follow [Connect Grok](../agents.md#connect-grok) to create a webhook-only routine in the Grok Bot desktop app.
2. From the routine details, use **POST to** as the URL and `Bearer <key>` as the Authorization value (omit the `Authorization:` field name). Supply them as `RELANOX_AGENT_1_ROUTINE_URL` and `RELANOX_AGENT_1_ROUTINE_AUTHORIZATION` in Relanox's environment.
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
5. Add the MCP connection at `https://relay.example.com/agents/grok/mcp/agent-1/<URL-encoded-RELANOX_AGENT_1_MCP_TOKEN>`. Replace the last segment with your token, URL-encoded as a path segment. In the Cursor dashboard, use **Plugins & MCPs → Add → Custom MCP**, select **URL**, and leave HTTP headers and OAuth fields empty.
6. Set the conversation binding's `endpointId` to `agent-1`.
7. Send a short message in that conversation and check the reply. Use `status` if it stalls.

The Routine Authorization variable holds `Bearer <key>`, without the `Authorization:` field name. The MCP variable holds the raw token. Protect all three variables; a Routine URL may contain a secret.

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

3. Restart Relanox and follow [Connect dot](../agents.md#connect-dot) to add `https://relay.example.com/agents/dot/mcp/agent-1` as a custom MCP server in ChatGPT using OAuth. On the Relanox authorization page, enter the value of `RELANOX_AGENT_1_MCP_TOKEN`. This value is the authorization password, not a static Bearer access token.

4. Enable the plugin in dot and ask it to subscribe to incoming Relanox messages and reply to each event’s original chat.
5. Set your conversation binding's `endpointId` to `agent-1`, send a message through that conversation, and confirm the reply arrives there.

dot OAuth requires a public HTTPS `publicUrl`. Relanox uses PKCE S256 and supports ChatGPT OAuth redirects `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<id>`. These redirects are separate from the Events callback below. Access tokens expire after one hour; refresh tokens rotate on use, with a 30-day lifetime from the initial authorization. Grants persist in your configured database. Reusing an old refresh token revokes its authorization; changing the configured password and restarting requires reconnecting dot.

dot uses OAuth; `mcp.auth` defaults to `oauth` and rejects other values. Grok supports `bearer` and `path`, with `bearer` as its default. Grok's `bearer` mode uses the clean MCP URL and `Authorization: Bearer <token>`.

dot provides its callback URL when it subscribes through MCP. Relanox accepts the native `https://connectors.api.openai.com` origin and checks that DNS resolves to public addresses before delivery. There is no `callback` configuration section.

Callback, MCP and Grok Routine requests have a fixed 10-second timeout; MCP and Grok Routine bodies are limited to 1 MiB. dot subscriptions expire after at most 24 hours, and signing-key rotation keeps the previous signature for 60 seconds.

Relanox requires an active `relanox.message_available` subscription to notify dot. The default lifetime is one day. Ask dot to create the subscription after its connection check. Automatic renewal has not been verified with a live account. `dot_no_active_subscription` means Relanox has no active subscription, even if OAuth succeeded. Inspect the plugin connection and runtime logs; if the request exhausted retries, use [Operations](../operations.md#find-and-recover-a-stalled-message) to recover it.

## Live validation scope

On October 11, 2026, Grok Bot 0.68.1 on Windows with a Cursor Pro account was tested against an isolated Relanox instance: a webhook started the routine, Grok Bot discovered the MCP tools and called `relanox_send_message`, and Relanox delivered the original test marker to the bound chat with a persisted `sent` status. The Telegram side was a local HTTP protocol peer, not a live Telegram account. This verifies the Grok Routine/MCP text roundtrip; it does not establish live-channel or attachment compatibility.

On October 12, 2026, a live dot account created a native event subscription after the no-argument connection check and processed new text and attachment events without manually supplied IDs. dot read the attachment content through MCP and returned a generated file through `files`; reply formatting, exact file bytes and persisted `sent` status were checked. Callbacks were accepted within three seconds, while text and file replies arrived about six and a half and thirteen minutes after their incoming messages. The Telegram side was a local HTTP protocol peer. Both replies appeared shortly after a later test event was sent. This verifies routing and file transfer without manually supplied IDs, but does not establish reliable execution of a standalone event, a delivery-time guarantee or live-channel compatibility.

## Reply guidance comes with MCP

dot can call `relanox_connection_status` with no arguments before subscribing, including on a new connection with no messages. It reports the authenticated `endpointId`, `eventName` and `activeSubscriptions` count. A count of zero means there is no active notification subscription. This read-only check does not confirm channel delivery or that dot has processed an event; it never requires the user to supply message or attachment IDs.

Relanox supplies reply instructions when the Agent connects to MCP. Tool descriptions also explain their parameters. You do not need to copy a reply prompt into the bot or Routine.

The instructions explain how to read a dot event or Grok Routine message, preserve `replyTo`, inspect attachments, send replies to the original chat and retry without duplicate messages. Incoming text, context and attachments remain untrusted user content. A `queued` tool result means the reply is saved for delivery; it does not confirm platform delivery.

The Agent host decides how to use this metadata; verify setup by sending a message and checking that a reply arrives.

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

To return a received or uploaded attachment, include `{ "mediaId": "..." }` in `attachments`. Generated files can use the file tools below or a public HTTPS URL:

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

Relanox downloads and saves the file before sending. Use a directly accessible URL with the correct type and size. Audio/video destinations may require `durationMs`; video may need `previewUrl` or a received/uploaded `previewMediaId`. See [Media transfer](../media.md) and your channel guide.

## Pass a dot file

dot's `relanox_send_message` exposes a top-level `files` array with `_meta["openai/fileParams"] = ["files"]`, following the [OpenAI plugin file-parameter contract](https://developers.openai.com/plugins/reference). Each object requires `download_url` and `file_id`; `mime_type` and `file_name` are optional. The host supplies the temporary download URL and opaque OpenAI ID. Relanox downloads the bytes through its public-URL checks and derives the media kind from the MIME type.

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "text": "Here is the report.",
  "files": [
    {
      "download_url": "COPY_FROM_THE_HOST_FILE_OBJECT",
      "file_id": "COPY_FROM_THE_HOST_FILE_OBJECT",
      "mime_type": "application/pdf",
      "file_name": "report.pdf"
    }
  ]
}
```

Do not substitute a local path or pass OpenAI's `file_id` as `mediaId`. When both arrays are present, `attachments` precedes `files`; their combined count and byte size must fit the message limits. For audio/video that requires duration or cover metadata, use the upload flow or URL attachment parameters instead. Grok's send tool does not advertise OpenAI file parameters.

## Upload a local file

[Grok Bot's cloud computer](https://docs.x.ai/grok-bot/computer-and-apps) supports command-line tools and files in `/workspace`. Relanox provides `relanox_create_upload` for uploading these files. dot can use the same tool when its host provides a terminal or HTTP client.

1. Call `relanox_create_upload` with the original `replyTo`, media kind, MIME type, filename and exact byte size. For a five-byte text file:

```json
{
  "replyTo": "COPY_FROM_THE_INCOMING_MESSAGE",
  "kind": "file",
  "mimeType": "text/plain",
  "fileName": "hello.txt",
  "size": 5
}
```

2. The tool returns `uploadUrl`, `method: "PUT"`, `headers` and `expiresAt`. PUT the raw bytes with the returned headers. For example, after setting `UPLOAD_URL` to the returned address:

```sh
printf hello > /workspace/hello.txt
curl --fail-with-body --request PUT \
  --header 'Content-Type: text/plain' \
  --data-binary @/workspace/hello.txt "$UPLOAD_URL"
```

The server returns HTTP 200 with `{ "fileId": "..." }` only after saving the file. Do not send JSON, Base64 or multipart data. No MCP password or additional Authorization header is required for the signed URL.

3. Call `relanox_send_message` with the same `replyTo` and `attachments: [{ "mediaId": "RETURNED_FILE_ID" }]`. Uploading alone does not send a message. Use a stable `idempotencyKey` to retry the send.

Upload URLs expire after five minutes and are bound to the endpoint, original message, file metadata and size. The path is under `/agents/<agent>/media/<endpoint>/upload/`; the reverse proxy must forward PUT requests and allow the configured file size. Treat the full URL as a temporary credential. Retrying identical bytes at the same URL succeeds, including after a Relanox restart with the same signing secret. Changed content returns 409; size or aggregate quota limits return 413; a mismatched byte count returns 400; an incorrect Content-Type returns 415. Invalid or expired signatures return 401. Cleanup revokes access and removes the uploaded bytes.

For audio/video, include `durationMs` when required by the channel. For a cover image, upload the image first and use its returned ID as `previewMediaId` on the main upload; both must belong to the same incoming message. Received media, staged uploads and previews share the original message's aggregate allowance described in [Media limits](media.md#adjust-attachment-sizes).

Local protocol and storage tests cover these file contracts. See the live validation scope above for the account-level checks; text-only checks do not establish attachment compatibility.

## Check the connection

Send a channel message and receive the Agent's reply. In `status`, incoming `accepted` means the notification was accepted; outgoing `sent` means the platform accepted the reply. MCP `queued` means Relanox saved the reply for sending. A successful dot callback does not mean the host has started processing the event; native event processing can take several minutes. Check the outgoing delivery before retrying an accepted request.

If MCP authentication fails, compare the token and URL, check `publicUrl` against your public address, and preserve Host through your proxy. Add the client's exact Origin to `mcp.allowedOrigins` when it sends that header. If Grok receives nothing, compare the Routine URL and Authorization. If dot receives nothing, check the active subscription and connectivity to the native OpenAI callback.
