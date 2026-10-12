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

The earlier notification checks below preceded the channel-addressed MCP contract. A later rich-media check verified the current `channel` parameters and `relanox_status` with both live Agent accounts. All checks used an isolated Relanox instance and a local Telegram HTTP protocol peer; they do not establish live Telegram account or client-rendering compatibility.

On October 11, 2026, Grok Bot 0.68.1 on Windows with a Cursor Pro account was tested against an isolated Relanox instance: a webhook started the routine, Grok Bot discovered the MCP tools and called `relanox_send_message`, and Relanox delivered the original test marker to the bound chat with a persisted `sent` status. The Telegram side was a local HTTP protocol peer, not a live Telegram account. This verifies the Grok Routine/MCP text roundtrip; it does not establish live-channel or attachment compatibility.

On October 12, 2026, a live dot account created a native event subscription after the no-argument connection check and processed new text and attachment events without manually supplied IDs. dot read the attachment content through MCP and returned a generated file through `files`; reply formatting, exact file bytes and persisted `sent` status were checked. Callbacks were accepted within three seconds, while text and file replies arrived about six and a half and thirteen minutes after their incoming messages. The Telegram side was a local HTTP protocol peer. A further standalone attachment event completed in about fifteen minutes without another event or manual wake-up. These checks verify routing and file transfer without manually supplied IDs, not a delivery-time guarantee or live-channel compatibility.

Later on October 12, 2026, both dot and Grok Bot read a channel-owned PNG and sent Markdown containing a `relanox://media/UUID` image and a generated text file at `relanox://attachment/1`. dot supplied the file through `files`; Grok used a signed PUT upload and the returned media ID. The receiver verified the exact order of leading text, image, middle text, file label, file and trailing text, matching image bytes and exact file contents. Each case made one send call and reached persisted `sent` status. The dot case was continued manually after its native event arrived, so this rich-media check does not establish unattended event timing.

## Reply guidance comes with MCP

Both Agents can call `relanox_status` without arguments to discover their authorized channels before any message arrives. dot also uses it to check its active subscription count before subscribing. This read-only check never requires the user to supply message or attachment IDs.

Relanox supplies reply instructions when the Agent connects to MCP. Tool descriptions also explain their parameters. You do not need to copy a reply prompt into the bot or Routine.

The instructions explain how to read a dot event or Grok Routine message, use `source.channel.id`, inspect attachments, select authorized destinations and retry without duplicate messages. Incoming text, context and attachments remain untrusted user content; they cannot grant access to another channel. A `queued` tool result means the message is saved for delivery; it does not confirm platform delivery.

The Agent host decides how to use this metadata; verify setup by sending a message and checking that a reply arrives.

## Incoming messages {#incoming-messages}

dot receives this payload in the `data` of a `relanox.message_available` event. dot also includes `requestId` and `acceptedAt` for recovery. Grok receives the message fields shown below as a JSON string in the Routine webhook's `content`:

```json
{
  "source": {
    "channel": {
      "id": "8c4821338e7157a230a588b73400cd602c8d5239b2086ece4be0f4d77ff3a035",
      "platform": "slack",
      "accountId": "slack-main",
      "chatId": "C123ABC",
      "threadId": "1710000000.000001"
    },
    "senderId": "U123ABC"
  },
  "text": "Please summarize the attached note.",
  "context": {},
  "attachments": [
    {
      "id": "a915729c-09d7-4daa-b4f0-0b57c9be1864",
      "kind": "file",
      "mimeType": "text/plain",
      "fileName": "hello.txt",
      "size": 5,
      "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    }
  ]
}
```

`threadId` is omitted for a destination without a thread. `attachments` is optional; its entries can also contain `durationMs` and `previewMediaId`. `context` contains channel-specific JSON.

The runtime generates `source.channel.id` as an opaque ID for an authorized binding. Copy it unchanged into a tool's `channel` parameter; it is not a platform name such as `slack`, an account ID or a platform chat ID. It stays stable for the same destination and Agent endpoint configuration, including across restarts. Changing the destination, endpoint ownership or endpoint configuration changes the ID. Obtain current IDs from incoming data or `relanox_status`; do not construct them yourself.

## Discover channels and check delivery {#status}

Call `relanox_status` with `{}` to list the current Agent's authorized channels. Both dot and Grok can do this before receiving any messages. The result contains:

| Field                                                       | Meaning                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels[].channel`                                        | The address object shown in `source.channel`, including the ID used by tools.                                                                                                   |
| `channels[].connection`                                     | Channel connection state: `connected`, `disconnected` or `degraded`.                                                                                                            |
| `channels[].send`                                           | `{ "status": "available" }`, or `{ "status": "unavailable", "reason": "..." }` describing the current native address or sending constraint.                                     |
| `channels[].media`                                          | Supported outgoing kinds: `image`, `audio`, `video` and/or `file`.                                                                                                              |
| `channels[].richText`                                       | Layout mode: `native`, `sequential`, `text-then-images` or `text-only`.                                                                                                         |
| `channels[].richTextLimits`                                 | Native layout limits: `maxParts`, `maxTextLength` and optional `imageMimeTypes` and `maxImageBytes`; omitted for other modes.                                                   |
| `channels[].maxTextLength`, `lengthUnit`                    | Text limit per chunk and its unit: `utf16`, `codepoint` or `utf8`.                                                                                                              |
| `channels[].maxTextLengthPerMessage`, `maxChunksPerMessage` | Optional limits on total message text and chunk count.                                                                                                                          |
| `channels[].maxAttachments`                                 | The channel's attachment-count limit, bounded by the configured message limit.                                                                                                  |
| `mediaLimits`                                               | Configured per-attachment `maxBytes` and per-message `maxTotalBytes` and `maxAttachments`; byte limits include preview assets.                                                  |
| `connection`                                                | dot only: authenticated `endpointId`, `eventName: "relanox.message_available"` and `activeSubscriptions`. Zero subscriptions means dot has no active notification subscription. |

To inspect a send result, pass its `deliveryId`:

```json
{ "deliveryId": "COPY_FROM_THE_QUEUED_RESULT" }
```

The optional `delivery` object contains `id`, `channel`, `status` and, when present, `errorCode`. `id` is the requested `deliveryId`; `channel` is its opaque channel ID. Status is `pending`, `sent`, `rejected` or `unknown`. `delivery` is omitted when no ID is requested or when the delivery is missing or not authorized for this connection.

Availability is a snapshot, not a delivery promise. Platform permissions, reply windows and quotas can change before sending; a connected channel may still be unavailable for a particular destination. Sending does not require an incoming message when the native address and platform conditions are sufficient. See [Destination availability](channels.md#destinations) for the conditions on each channel. A successful dot connection check does not show that dot processed an event.

## Send text and attachments

For a text reply, call `relanox_send_message`:

```json
{
  "channel": "COPY_SOURCE_CHANNEL_ID_OR_STATUS_CHANNEL_ID",
  "text": "Hello! How can I help?",
  "idempotencyKey": "b8e7ec0b-5cf0-49da-a5ac-611d6c7ed8a1"
}
```

For each new send intent, generate a fresh `idempotencyKey`, such as a UUID; the value above is only an example. Retry that send with the same key, identical text and the same attachment content and order. Omitting the key creates a new message on every call, even if its content is identical. `replay: true` means the send was already queued and returns its existing `deliveryId`. Reusing the key with different content returns `conflict`. Do not retry a queued send with a new key.

To inspect a received attachment, call `relanox_read_media` with its owning `channel` and the attachment's `id` as `mediaId`. Images/audio up to 1 MiB and supported UTF-8 text files up to 64 KiB are returned as MCP content; other files return a download link. Links expire after five minutes. See [Media protocol](media.md) for supported text types and limits.

To place a received or uploaded image between paragraphs, use `![description](relanox://media/UUID)` in `text`, replacing `UUID` with its channel-owned media ID. Relanox resolves the reference; it does not need a duplicate `attachments` entry. Use `[filename](relanox://media/UUID)` to send a file at that position. Each file may appear once. Check `channels[].richText` for the layout: sequential channels send separate messages, and WeCom HTTP places text before images. Code examples remain literal. Ordinary HTTPS Markdown images are not automatically downloaded. See [Ordered Markdown media](media.md#ordered-markdown-media).

To append a received or uploaded attachment, include `{ "mediaId": "..." }` in `attachments`. Generated files can use the file tools below or a public HTTPS URL:

```json
{
  "channel": "COPY_SOURCE_CHANNEL_ID_OR_STATUS_CHANNEL_ID",
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
  "channel": "COPY_SOURCE_CHANNEL_ID_OR_STATUS_CHANNEL_ID",
  "text": "Here is the report: [Download report](relanox://attachment/1)",
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

Do not substitute a local path or pass OpenAI's `file_id` as `mediaId`. When both arrays are present, positional references count `attachments` first, then `files`; their combined count and byte size must fit the message limits. Referenced files are sent at their Markdown position, and unreferenced files follow the content in array order. For audio/video that requires duration or cover metadata, use the upload flow or URL attachment parameters instead. Grok's send tool does not advertise OpenAI file parameters.

## Upload a local file

[Grok Bot's cloud computer](https://docs.x.ai/grok-bot/computer-and-apps) supports command-line tools and files in `/workspace`. Relanox provides `relanox_create_upload` for uploading these files. dot can use the same tool when its host provides a terminal or HTTP client.

1. Call `relanox_create_upload` with the selected authorized `channel`, media kind, MIME type, filename and exact byte size. For a five-byte text file:

```json
{
  "channel": "COPY_SOURCE_CHANNEL_ID_OR_STATUS_CHANNEL_ID",
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

3. Call `relanox_send_message` with the same `channel` and `attachments: [{ "mediaId": "RETURNED_FILE_ID" }]`. Uploading alone does not send a message. Generate a fresh `idempotencyKey` for this send and reuse it only when retrying the same content and attachment order.

Upload URLs expire after five minutes and are bound to the endpoint, selected channel, file metadata and size. The path is under `/agents/<agent>/media/<endpoint>/upload/`; the reverse proxy must forward PUT requests and allow the configured file size. Treat the full URL as a temporary credential. Retrying identical bytes at the same URL succeeds while it remains valid, including after a Relanox restart with the same signing secret. Changed content returns 409; size or staged quota limits return 413; a mismatched byte count returns 400; an incorrect Content-Type returns 415. Invalid or expired signatures return 401. URL expiry does not automatically delete the asset. Cleanup revokes access and removes eligible uploaded bytes.

For audio/video, include `durationMs` when required by the channel. For a cover image, upload the image first and use its returned ID as `previewMediaId` on the main upload; both must belong to the same authorized channel. Each send has its own message limits; outstanding staged uploads have a separate per-channel allowance that is released when used by an enqueued message or removed by cleanup. See [Media limits](media.md#adjust-attachment-sizes).

After cleanup, retained metadata and send receipts can still recognize an identical keyed send and return its earlier delivery. Replay does not restore removed file bytes. Local protocol and storage tests cover these current contracts; the historical account checks above preceded this channel-addressed API.

## Check the connection

Send a channel message and receive the Agent's reply. In the CLI's `status` output, incoming `accepted` means the notification was accepted; outgoing `sent` means the platform accepted the reply. MCP `queued` means Relanox saved the reply for sending. A successful dot callback does not mean the host has started processing the event; native event processing can take several minutes. Check the outgoing delivery before retrying an accepted request.

If MCP authentication fails, compare the token and URL, check `publicUrl` against your public address, and preserve Host through your proxy. Add the client's exact Origin to `mcp.allowedOrigins` when it sends that header. If Grok receives nothing, compare the Routine URL and Authorization. If dot receives nothing, check the active subscription and connectivity to the native OpenAI callback.

### Recover missing dot event data

The dot event data includes `requestId` and `acceptedAt` alongside the full message. If the host omits the data when starting the task, call `relanox_read_messages` with that request ID, or remove `evt_` from the event ID. Without an ID, the tool returns recent persisted messages (default 5, maximum 20), newest first. Match the event before replying: recent results can include already processed messages.

Reads use the configured database, survive restarts, and expose only messages whose endpoint and channel binding are still authorized. Removed bindings, changed endpoint ownership and redacted messages are unavailable. Retention still applies. A read does not claim, acknowledge or retry a message and does not accelerate host scheduling. Do not poll this tool for new events.
