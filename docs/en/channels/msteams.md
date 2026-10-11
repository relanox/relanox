# Microsoft Teams Bot Connector

Receive authenticated Teams activities and send independent conversation-reference replies.

Place the following object in the account’s `config`. Account IDs, sender allowlists, agent bindings, secret references and common recovery rules are described in [configuration](../configuration.md). See [agents](../agents.md) for the destination agent.

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

Output obtains a bot OAuth token using `https://api.botframework.com/.default`, then posts a text Activity under the frozen service URL's `/v3/conversations/<id>/activities[/<parentId>]`. Delayed output never relies on the original request's response or an ephemeral reply closure. Conservative chunking uses 12,000 UTF-16 units to fit the Teams activity envelope. Media/cards/commands, conversation creation, app installation and activity edits are excluded.

Optional `issuer`, `jwksUrl` and `tokenUrl` select trusted operator infrastructure; public defaults use Bot Framework's keys and Microsoft OAuth. `allowLoopback:true` permits HTTP loopback for authentic signed local peers, without skipping any JWT check. Redirects reject. The plugin declares `idempotentSend:false`; 429 is retryable, explicit provider 4xx is rejected, and ambiguous network/5xx/malformed success is unknown for explicit operator recovery.

Temporary OAuth acquisition failures are retryable before message submission; explicit token 4xx rejections remain rejected.

Accepted targets also freeze the Microsoft application ID in addition to the existing bot, tenant and service URL. Reusing a local account ID with a different identity/server rejects older targets before sending; rotating the secret/private key for the same identity remains supported. Restore matching account configuration before explicit recovery; see [configuration](../configuration.md) for unscoped targets.

If an operator removes a previously trusted service origin, an existing frozen target is explicitly rejected before OAuth or message traffic. This configuration refusal is not an uncertain external send; restoring the origin allows explicit delivery recovery.

Defaults: `issuer` is `https://api.botframework.com`; `jwksUrl` is `https://login.botframework.com/v1/.well-known/keys`; `tokenUrl` is `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`.
