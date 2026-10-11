# Microsoft Teams Bot Connector

Receive authenticated Teams activities and send independent conversation-reference replies.

Account `config` ([configuration](../configuration.md)):

Register the bot's Microsoft application/Azure Bot resource, enable the Teams channel, publish/install the Teams app into its permitted users/teams, and configure the messaging endpoint as the public HTTPS `/channels/<accountId>/activities`. Proactive output needs a valid installed bot conversation and application credentials. This implementation uses the public Bot Connector issuer and `client_credentials` OAuth protocol; deployment administrators must choose a tenant/app credential configuration that is supported by their bot registration, including an appropriate token URL for single-tenant or sovereign deployments.

```json
{
  "appId": "microsoft_application_id",
  "botId": "28:bot_activity_recipient_id",
  "tenantId": "allowed_teams_tenant_id",
  "appSecret": {
    "env": "TEAMS_APP_SECRET"
  },
  "trustedServiceOrigins": ["https://smba.trafficmanager.net"]
}
```

## Setup and delivery

The app ID (JWT audience/OAuth client) and bot ID (activity recipient/sender) have separate purposes. Configure trusted service **origins** explicitly for the deployed Teams region/cloud; include exact origins, without paths or trailing slashes. Do not trust an arbitrary activity `serviceUrl`. Sender allowlists use activity `from.id`; bindings use `conversation.id` and, for a reply with `replyToId`, that exact thread ID. The frozen target retains the service URL, conversation, bot, user, tenant and parent activity reference. Credentials are never stored in it.

Inbound RS256 JWT verification requires the pinned issuer/audience, valid expiration/not-before, the official configured JWKS signature, a key endorsed for `msteams`, and a JWT `serviceurl`/`serviceUrl` claim equal to the activity URL. The activity must have `channelId:msteams`, the configured recipient bot and tenant; a conversation-level tenant, when present, must also agree. Trusted service origin checks happen before any outbound credential disclosure. Emulator/skills/other Bot Framework channels have no authentication bypass. Text tasks wait for durable ingest before ACK; known core policy exclusions are diagnosed while unexpected storage errors return failures.

Output obtains a bot OAuth token using `https://api.botframework.com/.default`, then posts a text Activity under the frozen service URL's `/v3/conversations/<id>/activities[/<parentId>]`. Delayed output never relies on the original request's response or an ephemeral reply closure. Conservative chunking uses 12,000 UTF-16 units to fit the Teams activity envelope. Commands, conversation creation, app installation and activity edits are excluded.

Optional `issuer`, `jwksUrl` and `tokenUrl` select trusted operator infrastructure; public defaults use Bot Framework's keys and Microsoft OAuth. `allowLoopback:true` permits HTTP loopback for authentic signed local peers, without skipping any JWT check. Redirects reject. The plugin declares `idempotentSend:false`; 429 is retryable, explicit provider 4xx is rejected, and ambiguous network/5xx/malformed success is unknown for explicit operator recovery.

Temporary OAuth acquisition failures are retryable before message submission; explicit token 4xx rejections remain rejected.

Accepted targets also freeze the Microsoft application ID in addition to the existing bot, tenant and service URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported.

If an operator removes a previously trusted service origin, an existing frozen target is explicitly rejected before OAuth or message traffic. This configuration refusal is not an uncertain external send; restoring the origin allows explicit delivery recovery.

Defaults: `issuer` is `https://api.botframework.com`; `jwksUrl` is `https://login.botframework.com/v1/.well-known/keys`; `tokenUrl` is `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`.

## Media and native file consent

Inline attachments and personal-chat `application/vnd.microsoft.teams.file.download.info` files download before durable ingestion, including pure-media activities. Inline credentials stay on exact `trustedServiceOrigins`; OneDrive preauthorized downloads receive no bot Authorization. `mediaOrigins` optionally adds exact private download origins. Downloads enforce DNS/byte limits and refuse redirects. Set `supportsFiles:true` in the Teams app manifest.

Images up to 15,000 bytes send as native attachments with persisted bytes in a base64 data URL; larger personal-chat images and audio/video/files use native file consent: a durable `application/vnd.microsoft.teams.card.file.consent`, authenticated `fileConsent/invoke`, PUT of original bytes to the accepted OneDrive URL, then `application/vnd.microsoft.teams.card.file.info`. Consent verifies frozen user/conversation/bot identity, persists across restart, and waits without duplicate cards. Decline rejects; an uncertain consent-card post requires operator recovery.

Large personal-chat images arrive as OneDrive file cards rather than inline image previews and do not require `media.publicBaseUrl`. The app manifest must enable `supportsFiles:true`.

Large personal-chat images arrive as OneDrive file cards rather than inline image previews and do not require `media.publicBaseUrl`. The app manifest must enable `supportsFiles:true`.

Configure exact `trustedUploadOrigins` for the tenant's OneDrive upload infrastructure; default empty rejects untrusted origins. Bot credentials never accompany uploads. Native file consent only supports `personal` chat. Group/channel audio/video/file sends explicitly reject with `file_consent_requires_personal_chat`; they need a separately authorized Graph workflow that this adapter does not enable. Captions are separate text chunks.

Protocol: [Teams native files and inline images](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4). Local signed-JWT/HTTP/SQLite tests do not establish live-account compatibility.

[Media transfer](../media.md)

Group/channel images above 15,000 bytes use a scoped published URL instead of a base64 message envelope, requiring top-level `media.publicBaseUrl`. The documented Teams bot file-upload route is personal consent; all-scope Graph file delivery requires additional OneDrive/SharePoint authorization and is outside this adapter. Generic Bot Connector attachment APIs alone do not establish a Teams upload contract. Waiting consent consumes the configured delivery attempt budget; after exhaustion, late consent requires explicit delivery requeue.
