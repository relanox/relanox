# WhatsApp Business Cloud API

Use Meta’s WhatsApp Business Cloud API with signed webhooks and independent Graph API output.

Account `config` ([configuration](../configuration.md)):

Create a Meta app with WhatsApp Business Platform access, register the phone number, subscribe the app to the Business Account's `messages` Webhooks, and obtain a token with the required `whatsapp_business_messaging` permission and appropriate business/phone access. Set the public HTTPS callback to `/channels/<accountId>/webhook`, with the configured verification token. Register the Graph API version currently supported by your Meta app explicitly; Relanox never guesses or silently upgrades that version.

```json
{
  "phoneNumberId": "your_phone_number_id",
  "businessAccountId": "your_whatsapp_business_account_id",
  "apiVersion": "v25.0",
  "appSecret": {
    "env": "WHATSAPP_APP_SECRET"
  },
  "verifyToken": {
    "env": "WHATSAPP_VERIFY_TOKEN"
  },
  "accessToken": {
    "env": "WHATSAPP_ACCESS_TOKEN"
  }
}
```

## Setup and delivery

The version above is an example, not a promised account version. Sender allowlists and bindings' `chatId` use the customer's WhatsApp `from` ID. Source message IDs deduplicate within the configured account. There is no group/thread support in this Cloud integration. The plugin freezes the Business Account, canonical API base, phone and customer address and originating message reference, strips credential/raw-event material, and chunks at 4,096 UTF-16 units.

GET verifies `hub.mode`, `hub.verify_token` and returns the supplied challenge. POST verifies exact-byte app-secret HMAC-SHA256 `X-Hub-Signature-256`, the Business Account ID and phone metadata before durable ingest. Status notifications and unsupported message types create no task. Text and native image/audio/video/document messages are durably accepted. Ingest policy exclusions are diagnosed; storage failures never receive successful ACKs.

Customer-service free-form text and native media are sent. Authenticated inbound timestamps establish the 24-hour customer window; its latest expiration is atomically persisted per API server, Business Account, phone and customer. Delayed sends reject expired windows locally, and a newer customer message can refresh the same durable customer's window. Future timestamps beyond five minutes are rejected. The provider still enforces actual account eligibility and policy. Templates, marketing initiation, stickers and consumer WhatsApp/Web/Baileys are excluded.

Output uses `POST /<apiVersion>/<phoneNumberId>/messages`, bearer token, `messaging_product:whatsapp`, an individual recipient and a text body. Valid responses supply the platform message ID. The provider has no durable idempotency key in this integration: HTTP 429 retries with the returned delay, explicit 4xx rejects, and ambiguous network/5xx/malformed success is unknown for operator recovery.

Optional `apiBase` defaults to `https://graph.facebook.com`; configured HTTPS gateways are operator trust. `allowLoopback:true` permits HTTP loopback protocol peers. Redirects reject. Credentials must be environment SecretRefs.

Pending targets refuse delivery if the configured phone, Business Account or API server changes. Token rotation for the same identity remains supported; the configured nonsecret identity must remain accurate because opaque tokens cannot independently prove that identity. Unscoped customer windows are not reused.

## Native media

Signed webhooks identify image, audio, video and document assets by media ID. Relanox retrieves `GET /<apiVersion>/<mediaId>?phone_number_id=<configuredPhone>`, then downloads the returned short-lived URL with the bearer token. Credentials are confined to the configured API origin or HTTPS lookaside.fbsbx.com; message-supplied URLs and foreign origins reject. Captions and document filenames are preserved. Downloads reject redirects and enforce core and native-kind limits.

Output first uploads multipart file/type/messaging_product to `POST /<apiVersion>/<phoneNumberId>/media`, then sends the returned ID through native image/audio/video/document message fields. Documents preserve filenames. The adapter permits JPEG/PNG images up to 5,000,000 bytes; AAC/AMR/MP3/MP4/OGG audio and MP4/3GPP video up to 16,000,000 bytes; text/PDF and supported Microsoft Office documents up to 100,000,000 bytes. A lower core limit still applies. Meta requires Opus mono OGG audio, H.264/AAC video and valid image formats; Relanox does not transcode or validate codec bitstreams. Independent SDK previews and durations are not accepted by these native message fields.

The 24-hour customer-service window applies to media too. Pre-message upload failures are safe to retry; ambiguous message creation remains unknown. Media is buffered and durably stored, without streaming. Local signed HTTP/SQLite/MCP/multipart tests verify protocol byte relay, not live-account compatibility.

Protocol source: [WhatsApp Business Platform media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media).

[Media transfer](../media.md)
