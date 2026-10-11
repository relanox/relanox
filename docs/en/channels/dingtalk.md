# DingTalk application robot

Reception uses application robot Stream CALLBACK events; output uses independent OAuth single/group robot APIs.

Account `config` ([configuration](../configuration.md)):

```json
{
  "clientId": "application-client-id",
  "clientSecret": {
    "env": "DINGTALK_APP_SECRET"
  },
  "robotCode": "application-robot-code",
  "apiBase": "https://api.dingtalk.com",
  "maxReconnectAttempts": 20
}
```

## Setup and delivery

Enable Stream in the application robot configuration, use the matching `robotCode`, and grant the application robot independent single/group message API permissions. Users must be reachable by the application; the robot must belong to the group. Direct-message recipients require a usable `senderStaffId`. Sender allowlists use the trusted callback's opaque `senderId`, which avoids assuming corporate staff IDs are globally unique. DM bindings use `senderStaffId`; group bindings use `conversationId` (the OpenAPI `openConversationId`). Callbacks with another robot code, own-bot sender or group `isInAtList != true` are ignored.

Stream connections obtain fresh tickets. Ping/pong detects dead connections; bounded exponential reconnect obtains a new ticket. Shutdown stops the account’s socket and reconnect work.

Stable `data.msgId` is the durable source identity; `headers.messageId` identifies the particular delivery ACK. Text ACK `{code:200,data:"{\"response\":null}"}` is sent after durable ingestion succeeds. A failed storage write produces no successful ACK. Unsupported or malformed input is diagnosed and receives a non-success callback response. The protocol can still duplicate callbacks; storage source deduplication remains authoritative.

Durable targets contain staff ID or open conversation ID and no `sessionWebhook`, ticket or access token. OAuth `/v1.0/oauth2/accessToken` credentials resolve at use. Tokens are kept in memory and refreshed before expiry, after explicit auth expiry or SecretRef environment rotation. Single sends POST `/v1.0/robot/oToMessages/batchSend` with one `userIds` entry. Group sends POST `/v1.0/robot/groupMessages/send` with `openConversationId`. Text sends carry `robotCode`, `msgKey:"sampleText"`, and JSON-encoded `msgParam:{content:...}`, authenticated by `x-acs-dingtalk-access-token`.

Text chunks conservatively use 4000 UTF-8 bytes. `processQueryKey` is retained as a query handle in receipt data; it is not presented as a platform message ID. Invalid staff IDs reject; flow-controlled single recipients and 429 retry with bounded delays; permission failures reject. Missing/malformed acceptance responses, network loss and generic 5xx preserve unknown effects. `idempotentSend=false`; no client-generated send UUID is documented for these APIs.

`apiBase` can select a deployment-approved API domain or proxy. Redirects are refused, TLS verification remains enabled, and only explicit `allowInsecureLoopback:true` permits plain HTTP/WS on loopback for local protocol peers. It cannot permit remote insecure endpoints. Operators should restrict configuration access because the API base receives application credentials.

Accepted targets also freeze the client ID, robot code and normalized API base URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

`maxReconnectAttempts` accepts 0–1,000 and defaults to 20.

## Media

Stream picture/audio/video/file and rich-text callbacks resolve `downloadCode` or `pictureDownloadCode` through `/v1.0/robot/messageFiles/download`. Bounded resource bytes are durable before successful ACK; pure media, speech transcription and rich-text captions are accepted.

Output submits multipart field `media` to `uploadBase` (default `https://oapi.dingtalk.com`), then sends `sampleImageMsg`, `sampleAudio`, `sampleVideo` or `sampleFile` to the frozen single/group target. JPEG/PNG/GIF/BMP images, MP4 video and files are limited to 20 MiB, AMR audio to 2 MiB. File templates accept XLSX/PDF/ZIP/RAR/DOC/DOCX. Audio requires `durationMs`; video also requires an image `previewMediaId` from the same request. Missing metadata and unsupported formats/sizes reject explicitly; durations/thumbnails are never invented. Captions use independent text chunks.

`mediaOrigins` optionally contains exact private download origins. Downloads enforce DNS/byte limits and refuse redirects; loopback HTTP additionally requires the trusted origin and `allowInsecureLoopback:true`. Media targets also freeze `uploadBase`, without persisting credentials.

Protocols: [native upload](https://open.dingtalk.com/document/development/upload-media-files), [robot download](https://open.dingtalk.com/document/development/download-the-file-content-of-the-robot-receiving-message). Local native HTTP/socket and SQLite tests do not establish live-account compatibility.

[Media transfer](../media.md)
