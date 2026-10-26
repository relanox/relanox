# Architecture

Relanox is a Go service connecting native messaging accounts to cloud agents.

The application constructs concrete channel, agent, storage, speech and observer
components directly. Shared interfaces live in `internal/model`. There is no plugin
registry, loader, install command or dynamic module discovery. Configuration lives
in `internal/config`; standard HTTP transport lives in `internal/transport`.

## Native SDK boundaries

Native clients use SDKs where their contracts preserve cancellation, bounded I/O,
native identifiers and durable delivery decisions. The application owns acceptance,
checkpoints, authorization, retry scheduling and final-reply state even when a
library performs the HTTP call. Versions are pinned in `go.mod`.

| Channel | Library use and retained native responsibilities |
| --- | --- |
| Telegram | `go-telegram/bot` for Bot API sends and file metadata; webhook acceptance stays behind the durable ingest boundary. |
| Discord | `discordgo` REST requests with send replay disabled; Gateway checkpoints and history recovery remain explicit. |
| Slack | `slack-go/slack` REST and file downloads; bounded Socket Mode and signed uploads retain their own transport. |
| Feishu / Lark | `oapi-sdk-go/v3` IM clients, token requests and event models; callback authentication and durable acceptance remain explicit. |
| WeCom | `wecom-aibot-go-sdk` crypto; socket lifecycle, authorization and passive reply retrieval remain native. |
| WeChat | `openilink-sdk-go` sends, upload URL requests and media crypto; polling preserves native ID types, and QR pairing follows the current login contract. |
| DingTalk | Stream SDK payload types; ticket acquisition, bounded sockets and robot REST remain native. |
| QQ | Native Gateway and v2 HTTP adapters preserve fields and identifier types missing from the available Go SDK. |
| Microsoft Teams | `oauth2/clientcredentials` for tokens and JWT/key libraries for authentication; Bot Framework activities and file consent remain native. |
| WhatsApp | `piusalfred/whatsapp` typed message sender; media metadata validation and in-memory MIME uploads retain native handling. |
| Matrix | `mautrix` sync, REST, media and transaction APIs; durable sync checkpoints and gap recovery remain explicit. |
| Mattermost | `Client4` REST, upload and history APIs; WebSocket resume and durable sequence checkpoints remain explicit. |
| Google Chat | Generated Google Chat API client and Google authentication libraries. |
| LINE | Messaging API and Blob clients, webhook models and signature validation; durable push retry keys and their expiration remain explicit. |
| Signal | `signalcli` JSON-RPC client with response-ID validation; SSE reconnects preserve the durable `Last-Event-ID`. |
| IRC | `irc.v4` parsing and serialization; TLS, capability negotiation, SASL and connection ownership remain explicit. |

These dependencies include both platform-maintained and community libraries. A
retained adapter must document the concrete SDK limitation near its implementation,
such as inaccessible read limits, cancellation gaps, premature acknowledgements,
unsupported fields or license distribution constraints. Native error status and
headers must survive SDK decoding; an ambiguous send must not become a safe retry.

The hosted agents share the official MCP Go SDK. dot event signing uses Standard
Webhooks, Muse encryption uses `flynn/noise` with Muse framing and nonce limits,
and Grok uses the documented Cursor Routine webhook. See [Hosted agents](agents.md)
for setup, acknowledgement semantics and the limits of local protocol validation.

## Message flow

An authenticated native input identifies an account, sender and exact conversation
or thread. Account allowlists and a matching binding authorize acceptance; a binding
can narrow allowed senders. The core commits immutable endpoint ownership, original
content, media and any captured preparation plan atomically before returning an
ingest receipt. The platform's event ID deduplicates repeated input.

Optional preparation, including Tencent speech, produces separately persisted
results without changing routing or original media. The worker claims bounded,
fairly scheduled work with a lease token and version. It notifies the captured
agent, then records the outcome. A crash after a possible remote side effect yields
an unknown result unless the native operation is safely idempotent. Cancellation
before an effect and cancellation after transmission are distinct outcomes.

An authenticated agent receives a principal scoped to its current endpoints. Every
status, message, media and send operation rechecks current channel ownership. Reads
expose public message content, never private platform reply targets or credentials.
History is bounded and filtered in storage before ordering and limiting. Pending
requests are oldest first with a stable accepted-time/request-ID cursor.

Each accepted send has independent durable destination/endpoint ownership, ordered
native chunks and an idempotency key. Progress replies do not complete requests.
Only one final delivery can be associated with a request, and it completes only
after every text/media chunk is confirmed sent. WeCom callback replies retain a
pending outcome while awaiting platform retrieval. Expiring native capabilities are
checked again at send time.

## Storage, media and security

SQLite and PostgreSQL implementations use Ent schemas, typed queries/transactions
and generated migrations. Unsupported database formats are refused without
discarding data. Lease claims, settlements, state compare-and-set,
media budgets, authorization and enqueue operations require atomic checks.

Media is owned by the relay, scoped to a channel, identified by immutable metadata
and a checksum, and committed atomically with the message that references it.
Platform download URLs are transient inputs, never durable assets. Preview images
must share channel ownership and count toward transactional budgets. Metadata may
survive content retention to recover accepted idempotent sends. Native length units,
rich image ordering and send/receive capability differences remain explicit.

HTTP requests carry context cancellation, deadlines and bounded responses. Remote
downloads reject private/reserved destinations and DNS rebinding. Explicit local
bridges require a configured private-host allowlist. Redirects stay on the original
origin. Public deployment URLs come only from validated configuration. Secrets are
environment/file references resolved at use time, and normal logs accept only
operational metadata. Public native/MCP HTTP endpoints and private management
endpoints must remain separate.
