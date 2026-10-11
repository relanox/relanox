# Google Chat HTTP app

Configure a native HTTP Chat app. Its authentication audience must exactly match the public HTTPS `/channels/<accountId>/webhook` URL.

Account `config` ([configuration](../configuration.md)):

Enable the Chat API in the app's Google Cloud project, create an app service account, and store its service-account JSON as an environment variable. Install the app into the intended spaces and ensure organization policies permit it. Sending uses app authentication with `https://www.googleapis.com/auth/chat.bot`; it does not impersonate a human or grant domain-wide delegation.

```json
{
  "audience": "https://relay.example/channels/chat/webhook",
  "callerEmail": "chat@system.gserviceaccount.com",
  "serviceAccount": {
    "env": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
  }
}
```

## Setup and delivery

`callerEmail` defaults to the documented shared Chat caller above. Signed RS256 OIDC tokens must have issuer `https://accounts.google.com`, exact configured audience, unexpired `exp`, `iat`, verified email and that caller email. Public keys come from the pinned Google OAuth JWKS endpoint. Caller identity is never taken from JSON alone. Native `MESSAGE` events require a sender and space; app-authored messages and empty content without attachments are ignored. `argumentText` is preferred to remove the app mention. Stable message resource names deduplicate within the account. Allowlist senders use `users/<id>` and bind `chatId` to `spaces/<id>` plus exact `threadId:spaces/<id>/threads/<id>` when present.

The frozen target carries the space, thread and original message resource. Relanox obtains OAuth by signing a service-account JWT and exchanging it at Google's token endpoint, then independently calls `POST /v1/spaces/<id>/messages`. Thread output sets `messageReplyOption=REPLY_MESSAGE_OR_FAIL`, preserving the accepted thread instead of creating an unrelated one. Each chunk is at most 30,000 UTF-8 bytes. Incoming cards, slash commands, edits and membership actions are excluded.

Optional `issuer`, `jwksUrl`, `tokenUrl` and `apiBase` configure trusted sovereign/proxy infrastructure; defaults are Google public issuer/JWKS/OAuth/Chat API. They are static operator trust, never event-selected URLs. `allowLoopback:true` permits HTTP only to loopback for signed local peers. Redirects reject. Service account keys remain in the environment, never target/context/storage. HTTP 429 is retryable, explicit 4xx is rejected, and ambiguous 5xx/transport/malformed send response is unknown. The channel declares no durable idempotency guarantee.

Temporary OAuth acquisition failures are retryable before message submission; explicit token 4xx rejections remain rejected.

Accepted targets also freeze the service-account client email and normalized API base URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

Defaults: `callerEmail` is `chat@system.gserviceaccount.com`; `issuer` is `https://accounts.google.com`; `jwksUrl` is `https://www.googleapis.com/oauth2/v3/certs`; `tokenUrl` is `https://oauth2.googleapis.com/token`; `apiBase` is `https://chat.googleapis.com`.

## Media and app identity

Native uploaded attachments download through `attachmentDataRef.resourceName` and authenticated `/v1/media/<resource>?alt=media` with `chat.bot`. Resources must belong to the event space. Pure media becomes a durable task. Drive-backed references require separate Drive authorization and reject explicitly. Downloads enforce DNS/byte limits, credentials stay on the configured API origin, and redirects reject.

With top-level `media.publicBaseUrl`, output images use native `cardsV2` image widgets and a named download button. Audio/video/ordinary files use named download buttons: these are **link fallbacks**, not uploaded native attachments. The frozen bot/space/thread identity and `REPLY_MESSAGE_OR_FAIL` remain intact; captions are separate text chunks. Send capabilities describe kinds accepted for this documented card/link delivery.

Google's native upload API requires user OAuth (`chat.messages.create`/`chat.messages`), not the configured service-account `chat.bot` identity. Its documented flow uploads file bytes with `media.upload`, then passes the returned `attachmentDataRef` in the message's `attachment` list. It cannot replace the current bot delivery without adding separately authorized user credentials and changing the sender identity. Relanox never implicitly impersonates a user or enables domain delegation. Card `imageUrl` requires an HTTPS-hosted image; inline base64/data URLs are not a documented alternative. Consequently, media replies with the current app identity require `media.publicBaseUrl`. Protocols: [download](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download), [upload authentication](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/upload), [upload and attachment flow](https://developers.google.com/workspace/chat/upload-media-attachments), [card image URL](https://developers.google.com/workspace/chat/api/reference/rest/v1/cards#image). Local signed-JWT/HTTP/SQLite tests do not establish live-account compatibility.

[Media transfer](../media.md)
