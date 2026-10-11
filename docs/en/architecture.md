# Architecture

Relanox is a resident text gateway. It persists channel input, hands it to an existing dot or Grok Bot, and returns the asynchronous final result to the original conversation. It does not run a model. [Configuration](configuration.md) controls deployment; [Core](reference/core.md) and [SDK](reference/sdk.md) define runtime and persistence contracts.

## Components

Channel → Core → Agent → hosted dot/Grok; Core ↔ Storage; CLI manages lifecycle; Observability records local stages.

| Component     | Responsibility                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| SDK           | Values, configuration, messages, Host and plugin contracts                                                                         |
| Core          | Authorization, exact bindings, deduplication, claims, result correlation, retry decisions, HTTP routing and bounded worker batches |
| Channel       | Platform authentication, input normalization, independent sending and receipts                                                     |
| Agent         | Hosted-agent authentication/transport, MCP tools and notifications                                                                 |
| Storage       | Schema, indexes, snapshots and atomic durable operations                                                                           |
| Observability | Logs, metrics and short local traces                                                                                               |
| CLI           | Concrete plugin assembly, HTTP listeners, worker loop, connections and administration                                              |

Core and plugins depend on SDK. CLI assembles concrete implementations. Channels and agents receive scoped Hosts and namespaced protocol state, never direct Storage access. Storage enforces atomic predicates; Core chooses business transitions.

## Durable message flow

The database holds `inbound` requests with frozen snapshots, claim tokens and notification progress; `outbound` final text with chunks, send progress and receipts; and `plugin_state` subscriptions/cursors within plugin namespaces.

1. A channel authenticates the event. Core checks sender allowlists and an exact account/chat/thread binding, then commits before acknowledging input. Deduplication uses channel, account and stable platform event ID.
2. Acceptance freezes the endpoint, credential references and serializable reply target. Binding changes cannot redirect old requests. An agent cannot supply another destination.
3. The worker leases due work. Grok receives a Routine payload; dot receives a notification and reads the task through MCP. Dispatch does not wait for remote work.
4. An authenticated agent claims within its endpoint scope. Only one request per endpoint is active. Repeating the same claim key returns the same durable claim token.
5. Completion checks the token and commits the final result and outbound together. Identical completion replay is idempotent; a different final result conflicts.
6. The channel sends frozen-target chunks and stores each receipt. Known transient failures can retry. Ambiguous sends stop automatic effects and require explicit recovery unless the channel declares sufficient send idempotency.

Short lease tokens and versions prevent stale local settlement. They cannot undo a transmitted network request. Long claims survive restart without automatic timeout release. Explicit request requeue revokes the old token. Exactly-once external effects depend on platform idempotency/query capabilities.

Storage is the only authority for durable work; no separate queue service is required. Startup resumes committed work. Connections without replay cannot promise recovery of messages missed while disconnected. Retention preserves unfinished requests, undelivered results and deduplication information.

## Lifecycle and security

Each instance uses one authoritative SQLite or PostgreSQL backend. Startup validates all plugin configurations, initializes missing schema, checks storage, registers handlers and starts connections/the worker. Diagnosis is read-only. Shutdown stops acceptance and drains short calls within a bounded total budget.

Channel and agent protocols authenticate separately. Message text grants no authority. Credentials resolve from environment references at use and are absent from durable request snapshots and logs. dot callbacks enforce exact authorization, DNS address policy and redirect refusal. HTTP and external-call sizes/times are bounded.

Business MCP/webhook routes belong behind HTTPS. Management uses a separate literal-loopback listener. Telemetry failure cannot block durable work; logs omit bodies/secrets and metric labels have finite vocabulary. Traces cover local relay stages, not remote inference. See [Observability](reference/observability.md) and [Operations](operations.md).

## Source responsibilities

Package entrypoints are stable public boundaries. Internal modules import concrete siblings rather than their own `index.ts`.

| Source                               | Responsibility                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/sdk/src`                   | Values, config, messages, state, storage, observability and plugin hosts           |
| `packages/core/src/config`           | Shape, reference relationships, plugin validation and route indexes                |
| `packages/core/src/hosts`            | Scoped channel/agent hosts, namespaces, connection telemetry and setup             |
| `packages/core/src/worker`           | Bounded sequential execution, outcome validation and retry policy                  |
| `packages/core/src/runtime.ts`       | Core assembly, HTTP, worker and administration                                     |
| `plugins/channel-*/src`              | Pure config/schemas, account runtime, transports and connection state              |
| `plugins/agent-*/src`                | Per-endpoint config, secrets, MCP and notification/Routine transport               |
| `plugins/storage-*/src`              | Database transactions, requests, leases, protocol CAS, inspection and codecs       |
| `plugins/observability-standard/src` | Configuration, sanitization, backpressure, metrics, traces and lifecycle           |
| `apps/cli/src`                       | Application config, plugin catalog, listeners, worker lifecycle and admin commands |

[Development](development.md) describes maintenance and verification. Local protocol peers and real storage tests protect contracts; they do not establish live-account compatibility.
