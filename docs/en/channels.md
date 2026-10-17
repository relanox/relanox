# Native channels

Accounts use native platform protocols and preserve native sender, conversation,
thread and message IDs. All accounts require a nonempty sender allowlist. A
matching binding authorizes acceptance; discovering an ID does not authorize it.

## Account options

Secret fields below take [secret references](configuration.md#credentials).
`account add` provides interactive forms; `--native-config` accepts additional
native options without introducing a plugin or compatibility format.

| Channel | Required native options | Connection and constraints |
| --- | --- | --- |
| Telegram | `botToken`, `webhookSecret` | Native webhook and Bot API; register the callback URL and `secret_token` with Telegram. Topics retain their native thread IDs. |
| Discord | `botToken` | Native Gateway and REST; the bot needs the required intents and channel permissions. Native nonce suppression has a short window and is not a durable retry guarantee. |
| Slack | `botToken`, `appId`, exactly one of `appToken` / `signingSecret` | Socket Mode uses an app token; signed Events API uses the signing secret. The installation's native team/bot/app identities must match. |
| Feishu / Lark | `appId`, `tenantKey`, `appSecret`, `verificationToken`, `encryptKey` | Signed/encrypted callback and native IM APIs. Set `domain` to `lark` for Lark. |
| WeCom | `botId`, `secret` for websocket mode | Native bot socket. Webhook mode instead uses `mode: "webhook"`, `token` and `encodingAESKey`; it supports a final passive reply within the native callback window. |
| WeChat | Saved by `wechat-login` | Native QR pairing and polling. The login command saves the actual bot token and confirmed user ID. |
| DingTalk | `clientId`, `clientSecret`, `robotCode` | Native Stream callbacks and robot REST APIs. Group messages must mention the robot. |
| QQ | `appId`, `clientSecret` | Native Gateway and v2 messages; optional `environment: "sandbox"`. Passive send permission is rechecked after uploads. |
| Microsoft Teams | `appId`, `botId`, `tenantId`, `appSecret`, `trustedServiceOrigins` | Authenticated Bot Framework activities, tenant/bot checks and trusted native service origins. Personal file delivery uses native consent. |
| WhatsApp | `phoneNumberId`, `businessAccountId`, `appSecret`, `verifyToken`, `accessToken` | Signed Cloud API webhook. Native customer-service windows still apply. |
| Matrix | `homeserver`, `accessToken` | Native `/sync`, media APIs and transactions through mautrix. End-to-end encrypted rooms require encryption support outside this account adapter. |
| Mattermost | `serverUrl`, `token` | Native v4 REST and WebSocket APIs; use the installation's HTTPS URL and a bot/user access token. |
| Google Chat | `serviceAccount` | Native authenticated interaction events and Chat REST APIs. Configure the printed webhook URL as the app's endpoint/audience. |
| LINE | `channelSecret`, `accessToken` | Signed Messaging API webhook and SDK push messages with native quote tokens and durable retry keys. |
| Signal | `serviceUrl`, `account` | Existing native Signal JSON-RPC daemon and event websocket. Optional `selfUuid` and authorization reference. |
| IRC | `server`, `nick` | TLS IRC/IRCv3 connection; optional server password and SASL credentials. Text only. |

For WeCom, DingTalk and QQ, `recipientTypes` can map known chat IDs to their native
recipient kind when a proactive target must be resolved before an incoming event.
The configured kind must match learned native identities. Local HTTP allowances
for supported test/bridge endpoints are explicit; untrusted media URLs do not
automatically gain private-network access.

## Callback paths and IDs

Prefix these paths with `http.publicUrl`; `{account}` is the local account ID.

| Channel | Inbound callback path | Binding / sender IDs |
| --- | --- | --- |
| Telegram | `/channels/telegram/{account}/webhook` | Numeric chat and sender IDs as strings; optional numeric topic `threadId`. |
| Discord | None; outbound Gateway connection | Native channel/thread and user snowflakes. |
| Slack | `/channels/slack/{account}/events` for signed Events API; none for Socket Mode | Native channel/user IDs and the original message `thread_ts` timestamp string. |
| Feishu | `/channels/feishu/{account}/webhook` | `chat_id`, sender `open_id`, optional native `thread_id`. |
| WeCom | `/channels/wecom/{account}/webhook` in webhook mode; none for socket | Native `userid` for a private chat; `chatid` for groups; sender `userid`. |
| WeChat | None; native polling | Confirmed native user ID from pairing, preserved as the chat/sender ID. |
| DingTalk | None; outbound Stream connection | `senderStaffId` for private chats; `conversationId` for groups; allowlist uses `senderId`. |
| QQ | None; outbound Gateway connection | Native C2C user openid or group openid; preserve incoming sender openid. |
| Teams | `/channels/msteams/{account}/activities` | Activity `conversation.id`, sender `from.id`, optional parent activity `replyToId` as thread. |
| WhatsApp | `/channels/whatsapp/{account}/webhook` | Native sender/phone identifiers exactly as supplied, without display formatting. |
| Matrix | None; native `/sync` polling | Room ID such as `!room:server`, user ID such as `@user:server`, optional thread root event ID. |
| Mattermost | None; outbound native WebSocket | Native 26-character channel/user IDs; optional thread root post ID. |
| Google Chat | `/channels/googlechat/{account}/webhook` | `spaces/...`, `users/...`, optional `spaces/.../threads/...`. |
| LINE | `/channels/line/{account}/webhook` | Native user/group/room IDs; allowlist uses sender `userId`. |
| Signal | None; outbound daemon event websocket | Chat `direct:<sender>` or `group:<groupId>`; sender UUID, with native number/source fallback. |
| IRC | None; outbound IRC connection | Native channel or direct nickname; use the native sender identity accepted by the connection. |

For socket/polling channels, no inbound callback route is needed. Their hosted
agent MCP and any public media URLs can still require the public HTTPS origin.

## Pairing and discovery

```sh
relanox wechat-login --account wechat --config relanox.json
relanox discover --account wecom --config relanox.json --timeout 2m
```

WeChat refresh creates a new credential file while preserving the old one and
existing bindings. Interactive additional verification is hidden; scripts can use
`--verification-code-file` with `--json`.

WeCom discovery can read a draft account before its allowlist/binding exists. It
uses a separate native socket, prints only chat/sender/thread IDs and never
forwards message content to an agent. To discover before an account exists, use
`--bot-id` with `--secret-env` or `--secret-file`. Add discovered sender IDs to the
allowlist and bind the exact chat before running the relay.

## Media and native availability

Telegram, Discord, Slack, Feishu, DingTalk, QQ, Teams, WhatsApp, Matrix, Mattermost and Signal support
native image, audio, video and file paths within platform limits. WeChat receives
those media kinds and sends images, video and files. LINE receives all four and
sends images, audio and video. IRC is text only. WeCom socket mode sends the four
media kinds; webhook mode sends images with its passive final reply. Native voice
recognition text is preserved where the platform supplies it.

Google Chat receives native attachments. Its outbound media uses public-URL image
cards and file buttons, rather than uploading native attachment objects. Several
other native rich/media paths also require the configured HTTPS origin to be
reachable by the external service. Teams personal files can remain pending until
the recipient grants consent. QQ and WhatsApp can become unavailable when native
reply windows expire.

The agent's `relanox_status` tool reports the current native capabilities and send
availability. Local protocol tests verify envelopes, authorization and recovery;
they do not prove live-account permissions or compatibility.

## Discord installation and threads

Install the bot in its guild and enable **Message Content Intent** under Developer
Portal → Bot → Privileged Gateway Intents. Eligible or verified applications may
need Discord approval. Relanox requests `GUILD_MESSAGES`, `DIRECT_MESSAGES` and
`MESSAGE_CONTENT`; content access also affects attachments and REST history.
See Discord's [Gateway documentation](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx).

Grant `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` for receiving and history recovery,
`SEND_MESSAGES` for replies, `ATTACH_FILES` for media and `EMBED_LINKS` for rich
embeds. Threads also need `SEND_MESSAGES_IN_THREADS` and visibility/membership for
private threads. Set binding `chatId` to the parent channel ID and `threadId` to
the native thread channel ID; omit `threadId` for ordinary channels. A direct
message binding uses its DM channel ID. Relanox does not create, join or unarchive
threads. Discord documents these [permissions](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx).

## Recovery boundaries

Discord first attempts native Gateway resume. An expired session falls back to
bounded REST history, up to 20 pages of 100 messages per configured conversation.
Receive-start boundaries are stored before the first connection, including newly
configured threads. An unavailable earlier anchor or an exceeded history bound
keeps the channel degraded/recovering rather than silently dropping history.

Mattermost persists the accepted native WebSocket sequence and connection ID.
When native resume cannot replay its queue, bounded history recovery requires a
complete visible batch of fewer than 1,000 posts per configured conversation.
Missing history, a full batch or a failed request preserves the previous cursor
and leaves recovery degraded. Previously edited or deleted posts do not become
new incoming messages. New bindings receive independent start boundaries.

Both channels accept the advanced account option `recoveryEpoch`. Leave it
omitted during normal operation. If inaccessible history cannot be recovered,
an operator can choose to abandon that inbound history by setting a fresh,
nonempty epoch and restarting. This can skip messages that were never accepted.
The same epoch does not reset again on later restarts, and already accepted Core
work remains queued. For Mattermost, use 1–128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`; Discord accepts at most 128 bytes without whitespace
or control characters. Keep each new recovery decision distinguishable.
