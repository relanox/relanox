# Hosted Agent protocols

Implemented by `@relanox/agent-dot` and `@relanox/agent-grok`, exported as `createDotAgentPlugin()` and `createGrokAgentPlugin()`. Both depend on SDK only for Relanox host contracts. Configure one instance per agent kind in the core agents map. Core validates every endpoint configuration before setup, supplies original endpoint snapshots plus `{}` to setup, and freezes endpoint SecretRefs at message acceptance. Plugins parse endpoint configs during setup and again during dispatch. Runtime credentials are resolved from environment at use, so rotating an environment value does not require rewriting persisted tasks.

Tests cover published protocols, the installed MCP SDK, real SQLite persistence and local HTTP peers. dot/Grok live-account support remains experimental; account installation, Bot comprehension of Routine content, approval rules and unattended execution have not been validated.

## Configuration and HTTP routes

Each endpoint has its own MCP route `/agents/dot/mcp/<endpointId>` or `/agents/grok/mcp/<endpointId>` and Bearer credential. Use independent random credentials for distinct endpoint scopes. The bearer is checked with constant-time digest comparison before invoking MCP or obtaining the scoped Host. A caller cannot choose endpoint IDs in tool parameters. URL host and Host header must agree and match `allowedHosts`; an Origin header, when present, must exactly match `allowedOrigins`. The default empty Origin list permits server-to-server requests without Origin. Forwarded host/origin headers are not trusted. Configure the actual public authority including a non-default port, or have the trusted reverse proxy preserve it.

Example endpoint configuration for dot:

```json
{
  "id": "my-dot",
  "agent": "dot",
  "dispatchMode": "push",
  "config": {
    "mcp": {
      "token": { "env": "DOT_MCP_TOKEN" },
      "allowedHosts": ["relay.example.com"],
      "allowedOrigins": [],
      "maxBodyBytes": 1048576,
      "timeoutMs": 10000
    },
    "callback": {
      "allowedOrigins": ["https://connectors.api.openai.com"],
      "transport": "public-https",
      "timeoutMs": 10000
    },
    "subscriptionTtlMs": 86400000,
    "rotationWindowMs": 60000
  }
}
```

The callback origin is an operator authorization decision. Verify the exact origin supplied by your account's subscription; the example is not an unrestricted trust rule or a promise that all accounts use that origin. Requests enforce byte limits even with absent/dishonest Content-Length. MCP body timeouts and callback/trigger durations are bounded. Core also applies its own HTTP and worker limits.

Example Grok endpoint:

```json
{
  "id": "my-grok",
  "agent": "grok",
  "dispatchMode": "push",
  "config": {
    "mcp": {
      "token": { "env": "GROK_MCP_TOKEN" },
      "allowedHosts": ["relay.example.com"],
      "allowedOrigins": [],
      "maxBodyBytes": 1048576,
      "timeoutMs": 10000
    },
    "routineUrl": { "env": "GROK_ROUTINE_URL" },
    "routineAuthorization": { "env": "GROK_ROUTINE_AUTHORIZATION" },
    "routineTransport": "https",
    "timeoutMs": 10000,
    "maxBodyBytes": 1048576
  }
}
```

Copy the entire URL and Authorization value from the selected Routine UI into these environment variables. No vendor/internal URL is constructed and no Bearer prefix is added to the Routine Authorization. The MCP token environment variable contains the raw token without `Bearer `. Never place these values in channel context or message text.

For an operator-controlled receiver on the same host, dot `callback.transport: "loopback-http"` or Grok `routineTransport: "loopback-http"` explicitly enables HTTP to literal `127.0.0.1` or `[::1]` only. dot still requires the exact origin (including port) in its allowlist. This supports local reverse-proxy/receiver deployments; it is not automatic development detection. Public production callbacks use HTTPS. The dot client resolves all destination addresses immediately before each connection, rejects non-public/special-use addresses, pins the selected address through Node's connection lookup, preserves the original TLS hostname, disables pooling and never follows redirects. Its conservative IPv6 policy excludes special-use/transition ranges. Grok URLs are administrator-selected SecretRefs, not caller-supplied tool data; redirects are also refused.

## MCP tools

MCP uses `@modelcontextprotocol/server@2.3.1` and `createMcpHandler(factory)`, with a fresh server per HTTP request. dot rejects the legacy era and requires `2026-07-28`. Grok uses the SDK's default stateless legacy compatibility and modern negotiation on the same route. No handcrafted initialize/session/version compatibility layer is present. All tool inputs and outputs are strict schemas. JSON/tool validation failures follow the SDK's own protocol/error envelope; durable business failures have `isError: true` with `structuredContent.status` and a text JSON mirror.

| Tool                   | Inputs                                        | Success                                        |
| ---------------------- | --------------------------------------------- | ---------------------------------------------- |
| `relanox_list_pending` | optional `limit` (1–100, default 20)          | `{requests:[...]}`                             |
| `relanox_claim`        | `requestId`, `claimKey`                       | `{status:"claimed",request,claimToken,replay}` |
| `relanox_complete`     | `requestId`, `claimToken`, `resultId`, `text` | `{status:"completed",deliveryId,replay}`       |
| `relanox_fail`         | `requestId`, `claimToken`, `errorCode`        | `{status:"updated",version}`                   |

Only listing is read-only; mutations are declared as mutations. IDs/claim keys/tokens are nonempty bounded strings, errorCode uses a bounded lowercase identifier, and final text is bounded. Request projection is exactly `{requestId,text,context,source:{channel,eventId}}`. It never includes endpoint configuration, SecretRefs, sender identifiers, private Routine URLs, account credentials, or reply destinations. Context is trusted channel protocol context, with no authority derived from message text.

Remote fixed instructions: claim before work or side effects; create an independent claimKey per remote run and reuse it only for a retry of that run. Proceed only after `status: claimed`. Complete using the returned claimToken, a stable resultId and final text; fail with a safe error code on terminal remote failure. Repeated notifications/Routine triggers may overlap: core's durable claim/token/final rules serialize the endpoint. HTTP receipt does not claim or complete a task. Claimed work is never automatically released/re-executed by a timeout. Remote model obedience and exactly-once external effects are not guaranteed.

## dot Events

The event name is `relanox.message_available`. Because the authenticated route already fixes the endpoint, subscription arguments are a strict empty object. Events methods accept MCP request `_meta` for progress and vendor metadata without using it for authorization or subscription identity. `events/list` returns the event's description, `delivery:["webhook"]`, empty input schema and `{requestId:string}` payload schema. Discovery advertises **top-level** `capabilities.events` alongside tools. The installed SDK's current MCP 2026 schema omits the draft Events capability and strips it; a narrow successful-discovery response augmentation preserves the capability on the wire while keeping SDK negotiation, headers and version validation intact.

`events/subscribe` accepts `{name,arguments:{},delivery:{mode:"webhook",url,secret},cursor?,ttlMs?}`. Only null/absent cursor is accepted: this event does not offer replay. The response is `{id,refreshBefore,cursor:null,truncated:false}`. Canonical JSON of authenticated endpoint owner, normalized URL, event name and arguments produces deterministic IDs. State is stored in SDK StateStore, including owner/endpoint, callback, signing key, granted expiry and bounded verification/rotation metadata. The normal lifetime is one day; configuration caps it at seven days. Requested durations grant no more than the configured cap. A minimum 1000 ms duration applies. `ttlMs:null` requests perpetual delivery but this implementation grants a finite configured lifetime; refreshBefore is always the actual expiry.

Before activation, a signed POST sends `{type:"verification",challenge:<fresh random value>}` with unique verification webhook-id. Success requires 2xx and a constant-time matching JSON challenge echo. Failure returns `-32015` CallbackEndpointError with a bounded reason, never an active state write. Verified owner/URL/key state is cached for at most 60 seconds; new/expired/changed-key subscriptions always challenge. Repeated matching subscriptions renew by exact-version CAS; races return subscription_conflict and may be retried. Expired entries are pruned when creating new identities. New identities are refused when the endpoint already has 100 active subscriptions. This admission check is not a transactional quota across different concurrent identities; the deployment should restrict callback authorization and subscriber concurrency accordingly.

On rotation, the old key is retained for the configured short overlap (default 60 seconds, maximum five minutes). Exact-body Standard Webhooks signatures for both keys are sent as space-separated `v1,...` signatures during that window. Keys must be canonical `whsec_` base64 encoding 24–64 bytes. Callback-provided signing keys must be durably stored so restart can resume delivery; protect the storage file/database. They are never logged or exposed by tools.

Dispatch sends one event per applicable active subscription:

```json
{
  "eventId": "evt_<requestId>",
  "name": "relanox.message_available",
  "timestamp": "<persisted acceptance ISO timestamp>",
  "data": { "requestId": "<requestId>" },
  "cursor": null
}
```

The ID and serialized body stay stable across retries. It carries no message instructions/body; read/claim tools supply the authoritative work. Body size is at most 256 KiB. Headers are Content-Type, webhook-id equal to eventId, fresh webhook-timestamp, Standard Webhooks webhook-signature, and X-MCP-Subscription-Id. Subscription expiry and current configured authorization are rechecked on dispatch. No active subscription returns retryable `dot_no_active_subscription` so core retains the task and exposes the diagnostic. Renewal can restore notifications while retry budget remains; after budget exhaustion an operator explicitly requeues the retained request.

2xx means accepted receipt. 429/5xx are retryable. Redirects and permanent 4xx, including 410/413, reject; 410 retires only the subscription version actually delivered, preserving a concurrent refresh or recreation. Event delivery uses the received HTTP status and discards the response body; only callback verification requires a bounded JSON body. HTTP 408 or loss of the status response through network/timeout failure is unknown. Multiple destinations are sent sequentially under the caller's bounded signal, and unknown dominates retryable, which dominates rejected. Retries reuse event IDs; receiver deduplication is still an external capability. `events/unsubscribe` matches `{name,arguments,delivery:{mode,url}}` under the authenticated endpoint; no signing secret is required. Delete is exact-version, idempotent when absent, and cannot reach another owner's identity. Missed notifications cannot be recovered via a replay cursor; pending business requests remain available through tools.

## Grok Routine envelope

The submitted JSON is `{content,source:"relanox",sentAt}`. `content` is a JSON string containing the same safe request projection as MCP; therefore requestId, Chinese/newlines/text and minimal protocol context remain present through the publicly demonstrated content path. sentAt uses the original persisted acceptance timestamp, so retries preserve submitted bytes. Fixed claim-before-effects instructions live in the Routine configuration and MCP server instructions, outside user message text. Payloads over the configured total byte limit reject before transmission. No guessed run-status/result callback API is used.

| Routine outcome                      | Dispatch classification                                |
| ------------------------------------ | ------------------------------------------------------ |
| 2xx                                  | accepted receipt; request remains pending              |
| 429, 5xx                             | retryable; bounded Retry-After seconds/date is honored |
| 408, network error, abort or timeout | unknown; explicit operator recovery                    |
| redirects and remaining non-2xx      | rejected                                               |

These are Relanox transport policy, not a claim about undocumented Grok internal side effects. MCP completion is the only durable final-result path. The public Coda/Linq implementations demonstrate JSON/content transmission, but are not a complete official Webhook schema or live-account proof.

## Sources and verification

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events): discovery, event/subscription schemas, callback verification, signing, rotation and delivery restrictions; checked 2026-10-11.
- [MCP SDK HTTP serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md), [custom methods](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/custom-methods.md), [versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md), [legacy serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md): verified against installed 2.3.1 source and actual SDK client traffic.
- [Coda Pack author implementation](https://connect.superhuman.com/t/how-a-coda-pack-calls-grok-bot/61506) and [fixed Linq forwarder source](https://github.com/jeffhuber/linq-grokbot-text-channel/blob/91eddc9203c28b747c81678f5012dd7e150b6c30/forwarder/api/index.js): evidence for content/JSON forwarding only; no copied runtime code.

Run `pnpm exec vitest run plugins/agent-dot/tests plugins/agent-grok/tests`. Core plus real SQLite exercise ingest → dispatch → SDK claim → complete → original outbound, restart, endpoint scope and stable protocol identities. Local peers independently verify HMAC headers and capture Routine bytes; they implement no Relanox business rules.
