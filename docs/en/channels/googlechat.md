# Google Chat HTTP app

Configure a native HTTP Chat app, not a Workspace add-on. Its authentication audience must exactly match the public HTTPS `/channels/<accountId>/webhook` URL. Workspace add-on envelopes, Pub/Sub/Workspace Events and project-number JWT mode are unsupported.

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

`callerEmail` defaults to the documented shared Chat caller above. Signed RS256 OIDC tokens must have issuer `https://accounts.google.com`, exact configured audience, unexpired `exp`, `iat`, verified email and that caller email. Public keys come from the pinned Google OAuth JWKS endpoint. Caller identity is never taken from JSON alone. Native `MESSAGE` events require a sender and space; app-authored messages and empty/media-only content are ignored. `argumentText` is preferred to remove the app mention. Stable message resource names deduplicate within the account. Allowlist senders use `users/<id>` and bind `chatId` to `spaces/<id>` plus exact `threadId:spaces/<id>/threads/<id>` when present.

The frozen target carries the space, thread and original message resource. Relanox obtains OAuth by signing a service-account JWT and exchanging it at Google's token endpoint, then independently calls `POST /v1/spaces/<id>/messages`. Thread output sets `messageReplyOption=REPLY_MESSAGE_OR_FAIL`, preserving the accepted thread instead of creating an unrelated one. Each chunk is at most 30,000 UTF-8 bytes. Cards, slash commands, edits, membership actions and attachments are excluded.

Optional `issuer`, `jwksUrl`, `tokenUrl` and `apiBase` configure trusted sovereign/proxy infrastructure; defaults are Google public issuer/JWKS/OAuth/Chat API. They are static operator trust, never event-selected URLs. `allowLoopback:true` permits HTTP only to loopback for signed local peers. Redirects reject. Service account keys remain in the environment, never target/context/storage. HTTP 429 is retryable, explicit 4xx is rejected, and ambiguous 5xx/transport/malformed send response is unknown. The channel declares no durable idempotency guarantee.

Temporary OAuth acquisition failures are retryable before message submission; explicit token 4xx rejections remain rejected.

Accepted targets also freeze the service-account client email and normalized API base URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

Defaults: `callerEmail` is `chat@system.gserviceaccount.com`; `issuer` is `https://accounts.google.com`; `jwksUrl` is `https://www.googleapis.com/oauth2/v3/certs`; `tokenUrl` is `https://oauth2.googleapis.com/token`; `apiBase` is `https://chat.googleapis.com`.
