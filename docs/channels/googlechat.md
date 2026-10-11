# Google Chat HTTP app

`@relanox/channel-googlechat` exports `createGoogleChatChannel()`. The implemented receive schema is the native HTTP interaction event for a Chat app that is **not** a Workspace add-on. Configure the Google Chat API app with HTTP endpoint URL authentication audience and set it to the exact public HTTPS `/channels/<accountId>/webhook` URL. Workspace add-on event envelopes, Pub/Sub/Workspace Events subscriptions and project-number self-signed JWT mode are not supported. Real accounts remain experimental and were not tested.

Enable the Chat API in the app's Google Cloud project, create an app service account, and store its service-account JSON as an environment variable. Install the app into the intended spaces and ensure organization policies permit it. Sending uses app authentication with `https://www.googleapis.com/auth/chat.bot`; it does not impersonate a human or grant domain-wide delegation.

```json
{
  "audience": "https://relay.example/channels/chat/webhook",
  "callerEmail": "chat@system.gserviceaccount.com",
  "serviceAccount": { "env": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON" }
}
```

`callerEmail` defaults to the documented shared Chat caller above. Signed RS256 OIDC tokens must have issuer `https://accounts.google.com`, exact configured audience, unexpired `exp`, `iat`, verified email and that caller email. Public keys come from the pinned Google OAuth JWKS endpoint. Caller identity is never taken from JSON alone. Native `MESSAGE` events require a sender and space; app-authored messages and empty/media-only content are ignored. `argumentText` is preferred to remove the app mention. Stable message resource names deduplicate within the account. Allowlist senders use `users/<id>` and bind `chatId` to `spaces/<id>` plus exact `threadId:spaces/<id>/threads/<id>` when present.

The frozen target carries the space, thread and original message resource. Relanox obtains OAuth by signing a service-account JWT and exchanging it at Google's token endpoint, then independently calls `POST /v1/spaces/<id>/messages`. Thread output sets `messageReplyOption=REPLY_MESSAGE_OR_FAIL`, preserving the accepted thread instead of creating an unrelated one. Each chunk is at most 30,000 UTF-8 bytes. Cards, slash commands, edits, membership actions and attachments are excluded.

Optional `issuer`, `jwksUrl`, `tokenUrl` and `apiBase` configure trusted sovereign/proxy infrastructure; defaults are Google public issuer/JWKS/OAuth/Chat API. They are static operator trust, never event-selected URLs. `allowLoopback:true` permits HTTP only to loopback for signed local peers. Redirects reject. Service account keys remain in the environment, never target/context/storage. HTTP 429 is retryable, explicit 4xx is rejected, and ambiguous 5xx/transport/malformed send response is unknown. The channel declares no durable idempotency guarantee.

Verified sources: [current caller/JWT and legacy mode documentation](https://developers.google.com/workspace/chat/verify-requests-from-chat), [interaction schema](https://developers.google.com/workspace/chat/receive-respond-interactions), [app authentication](https://developers.google.com/workspace/chat/authenticate-authorize-chat-app), [create message/thread options](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create). Vitest verifies real JWT signing, OAuth assertion bytes, core/SQLite and HTTP message requests, not real Google accounts.

OAuth acquisition is classified before a message request is emitted: temporary token service failures stay retryable, explicit token 4xx rejections stay rejected, and only ambiguous message requests become unknown. Access tokens are opaque nonempty strings, independent of the identifier length limit. Local audit regressions cover token 503/429 recovery, token 401 rejection and forwarding a token longer than 1024 characters.
