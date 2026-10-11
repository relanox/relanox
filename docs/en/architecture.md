# Architecture

Relanox is a resident message gateway. It persists channel text and media, hands them to an existing dot or Grok Bot, and sends asynchronous reply messages to the original conversation. [Configuration](configuration.md) controls deployment; [Core](reference/core.md) and [SDK](reference/sdk.md) define runtime and persistence contracts.

## Components

Channel → Core → Agent → hosted dot/Grok; Core ↔ Storage; CLI manages lifecycle; Observability records local stages.

| Component     | Responsibility                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| SDK           | Values, configuration, messages, Host and plugin contracts                                                                  |
| Core          | Authorization, exact bindings, deduplication, message correlation, retry decisions, HTTP routing and bounded worker batches |
| Channel       | Platform authentication, input normalization, independent sending and receipts                                              |
| Agent         | Hosted-agent authentication/transport, MCP tools and notifications                                                          |
| Storage       | Schema, indexes, snapshots and atomic durable operations                                                                    |
| Observability | Logs, metrics and short local traces                                                                                        |
| CLI           | Concrete plugin assembly, HTTP listeners, worker loop, connections and administration                                       |

Core and plugins depend on SDK. CLI assembles concrete implementations. Channels and agents receive scoped Hosts and namespaced protocol state, never direct Storage access. Storage enforces atomic predicates; Core chooses business transitions.

`channel-media` depends on SDK contracts and the shared `transport` primitives. It does not own media authorization, publication or persistence; those remain in Core and Storage. Channels keep their native platform upload/download protocols.

`agent-mcp` owns the MCP configuration, authentication guard, message tools, media download tickets and shared request projection used by dot and Grok. It depends on SDK contracts, the MCP server library and the shared `channel-media` bounded remote downloader, never Core or a concrete agent plugin. dot retains subscriptions and webhook dispatch; Grok retains Routine dispatch. The shared packages are libraries, not plugins registered in the CLI catalog.

`transport` contains shared HTTP body readers, bounded requests, signature checks, WebSocket helpers and public-address classification. Platform error mapping, credential policy and DNS trust decisions remain in the callers. `storage-support` shares durable JSON codecs, message/media digests and record/media predicates between the database plugins; SQL, transactions and database-specific decoding remain in each backend.

## Durable message flow

The database holds `inbound` messages with frozen snapshots and notification progress; `outbound` reply messages with text/media chunks, send progress and receipts; request-owned `media` bytes and metadata; and namespaced `plugin_state` subscriptions, cursors and publication tickets. Binary bytes stay outside JSON snapshots.

1. The channel authenticates an event. Core checks sender allowlists and an exact account/chat/thread binding, then commits before acknowledging input. Stable channel/account/event IDs deduplicate ingress.
2. Acceptance freezes the endpoint, credential references and reply target. Binding changes cannot redirect an existing message, and agents cannot supply another destination.
3. The worker leases each due notification. Grok receives a Routine payload and dot receives a signed event, both containing `replyTo`, text, context, source and attachment metadata. Dispatch does not wait for remote work. Accepted receipt ends automatic notification retry, and separate messages at the same endpoint can proceed independently.
4. An authenticated agent can read received media and call `sendMessage` with the event's `replyTo`. Each call commits its own outbound message and any generated media atomically. An input can receive multiple reply messages, including no reply at all.
5. Identical content without an explicit key reuses the queued message. An explicit idempotency key provides stable retry identity; reuse with changed text or attachment order conflicts. Use distinct explicit keys when identical content is deliberately sent twice. `queued` confirms durable acceptance, not delivery.
6. The channel sends chunks to the frozen target and stores each receipt. Replies to one input follow durable insertion order; an earlier pending or unknown delivery holds later replies until it advances or is explicitly recovered. Rejected delivery releases later replies, and separate inputs proceed independently. Known transient failures retry. Ambiguous effects stop automatic sends and require explicit recovery unless the platform supports durable send idempotency.

Short lease tokens and versions fence stale local settlement. They cannot undo a transmitted network request. Explicit request requeue repeats a notification; it does not cancel remote work or invalidate replies. Storage is the sole authority for durable work. Startup resumes due notifications and deliveries. Connections without replay cannot promise recovery of events missed while disconnected. Retention preserves due/unknown notifications, undelivered messages and durable deduplication records.

## Lifecycle and security

Each instance uses one authoritative SQLite or PostgreSQL backend. Startup validates all plugin configurations, initializes missing schema, checks storage, registers handlers and starts connections/the worker. Diagnosis is read-only. Shutdown stops acceptance and drains short calls within a bounded total budget.

Channel and agent protocols authenticate separately. Message text grants no authority. Credentials resolve from environment references at use and are absent from durable request snapshots and logs. dot callbacks enforce exact authorization, DNS address policy and redirect refusal. HTTP and external-call sizes/times are bounded.

Business MCP/webhook routes belong behind HTTPS. Management uses a separate literal-loopback listener. Telemetry failure cannot block durable work; logs omit bodies/secrets and metric labels have finite vocabulary. Traces cover local relay stages, not remote inference. See [Observability](reference/observability.md) and [Operations](operations.md).

## Source responsibilities

Package entrypoints are stable public boundaries. Internal modules import concrete siblings rather than their own `index.ts`.

| Source                               | Responsibility                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/sdk/src`                   | Values, config, messages, state, storage, observability and plugin hosts                         |
| `packages/channel-media/src`         | Bounded channel downloads, MIME classification and native upload helpers                         |
| `packages/agent-mcp/src`             | Shared hosted-agent MCP authentication, message tools, media downloads and safe event projection |
| `packages/transport/src`             | Shared HTTP, signature, WebSocket and address primitives                                         |
| `packages/storage-support/src`       | Durable value encoding, digests and storage predicates                                           |
| `packages/core/src/config`           | Shape, reference relationships, plugin validation and route indexes                              |
| `packages/core/src/hosts`            | Scoped channel/agent hosts, namespaces, connection telemetry and setup                           |
| `packages/core/src/worker`           | Bounded sequential execution, outcome validation and retry policy                                |
| `packages/core/src/runtime.ts`       | Core assembly, HTTP, worker and administration                                                   |
| `plugins/channel-*/src`              | Pure config/schemas, account runtime, transports and connection state                            |
| `plugins/agent-*/src`                | Per-endpoint config, secrets, MCP and notification/Routine transport                             |
| `plugins/storage-*/src`              | Database transactions, requests, leases, protocol CAS, inspection and codecs                     |
| `plugins/observability-standard/src` | Configuration, sanitization, backpressure, metrics, traces and lifecycle                         |
| `apps/cli/src`                       | Application config, plugin catalog, listeners, worker lifecycle and admin commands               |

[Development](development.md) describes maintenance and verification. Local protocol peers and real storage tests protect contracts; they do not establish live-account compatibility.
