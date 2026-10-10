# WhatsApp Business Cloud API

`@relanox/channel-whatsapp` exports `createWhatsAppChannel()`. This is Meta's Business Cloud API, with signed Webhooks and independent Graph messages. Real accounts remain experimental and were not tested.

Create a Meta app with WhatsApp Business Platform access, register the phone number, subscribe the app to the Business Account's `messages` Webhooks, and obtain a token with the required `whatsapp_business_messaging` permission and appropriate business/phone access. Set the public HTTPS callback to `/channels/<accountId>/webhook`, with the configured verification token. Register the Graph API version currently supported by your Meta app explicitly; Relanox never guesses or silently upgrades that version.

```json
{
  "phoneNumberId": "your_phone_number_id",
  "businessAccountId": "your_whatsapp_business_account_id",
  "apiVersion": "v25.0",
  "appSecret": { "env": "WHATSAPP_APP_SECRET" },
  "verifyToken": { "env": "WHATSAPP_VERIFY_TOKEN" },
  "accessToken": { "env": "WHATSAPP_ACCESS_TOKEN" }
}
```

The version above is an example, not a promised account version. Sender allowlists and bindings' `chatId` use the customer's WhatsApp `from` ID. Source message IDs deduplicate within the configured account. There is no group/thread support in this Cloud text baseline. The plugin freezes the phone and customer address and originating message reference, strips credential/raw-event material, and chunks at 4,096 UTF-16 units.

GET verifies `hub.mode`, `hub.verify_token` and returns the supplied challenge. POST verifies exact-byte app-secret HMAC-SHA256 `X-Hub-Signature-256`, the Business Account ID and phone metadata before durable ingest. Status notifications and non-text messages create no text task. Ingest policy exclusions are diagnosed; storage failures never receive successful ACKs.

Only customer-service free-form text is sent. Authenticated inbound timestamps establish the 24-hour customer window; its latest expiration is atomically persisted per customer. Delayed sends reject expired windows locally, and a newer customer message can refresh the same durable customer's window. Future timestamps beyond five minutes are rejected. The provider still enforces actual account eligibility and policy. Templates, marketing initiation, media and consumer WhatsApp/Web/Baileys are excluded.

Output uses `POST /<apiVersion>/<phoneNumberId>/messages`, bearer token, `messaging_product:whatsapp`, an individual recipient and a text body. Valid responses supply the platform message ID. The provider has no durable idempotency key in this implementation: HTTP 429 retries with the returned delay, explicit 4xx rejects, and ambiguous network/5xx/malformed success is unknown for operator recovery.

Optional `apiBase` defaults to `https://graph.facebook.com`; configured HTTPS gateways are operator trust. `allowLoopback:true` permits HTTP loopback protocol peers. Redirects reject. Credentials must be environment SecretRefs.

Protocol sources: [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/), [sending messages and service window](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages), [Meta webhook verification](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/), [Meta's published message collection](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ba8d099d-007e-4b52-b9f2-3cf3c60e4fbc). Meta's website can restrict automated documentation access; its official Postman collection confirms the phone message endpoint, bearer token and messaging permission. The documented wire schemas are exercised against local HTTP peers with production core/SQLite. No live account compatibility is claimed.
