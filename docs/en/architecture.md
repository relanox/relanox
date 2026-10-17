# Architecture

Relanox is a Go service connecting native messaging accounts to cloud agents.
The executable composes the native implementations described here.

The application constructs concrete channel, agent, storage, speech and observer
components directly. Shared interfaces live in `internal/model`. There is no plugin
registry, loader, install command or dynamic module discovery. Configuration lives
in `internal/config`; standard HTTP transport lives in `internal/transport`.

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
and generated migrations. New Go schemas must detect and refuse incompatible old
databases rather than discard data. Lease claims, settlements, state compare-and-set,
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
