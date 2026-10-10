# Relanox product requirements

Updated: 2026-10-11. This document supersedes the exploratory draft. [TODO](../TODO.md) tracks implementation; [ARCHITECTURE](ARCHITECTURE.md) defines contracts; [DEPENDENCIES](DEPENDENCIES.md) lists libraries.

## Product and delivery scope

Relanox connects messages to the user's existing hosted agents. It validates and persists incoming text, dispatches to dot/Grok, accepts authenticated asynchronous results, and sends them to the original conversation. It does not run inference or replace an existing agent.

The initial delivery includes **all 15 native text channels**. OpenClaw/Hermes source is reference material only: no plugin runtime, adapter, polyfill, or configuration compatibility. Deploy one resident Node service, with SQLite by default or PostgreSQL, and an independent observability plugin. No Serverless deployment.

| Channel | Required baseline |
|---|---|
| Telegram | Bot API authenticated Webhook and independent text send; chat/topic/reply target |
| Discord | Gateway message reception, REST send, channel/thread and bot identity |
| Slack | Declared Events HTTP or Socket Mode reception, Web API send, channel/thread |
| Feishu / Lark | Official event protocol/SDK reception and message API; tenant/domain/thread |
| WeCom | Intelligent robot WS authentication/reception and independent chat send |
| DingTalk | Application robot Stream reception and OpenAPI single/group send |
| QQ | Declared official WS/Webhook reception and C2C/group send; durable sequence/window handling |
| Microsoft Teams | Authenticated Bot activity endpoint and proactive conversation-reference send |
| WhatsApp | Business Cloud API Webhook and messages; customer-service text window |
| Matrix | Client-server sync/send, room/event identity; encrypted input must be explicitly unsupported if E2EE is absent |
| Google Chat | Authenticated app events and app-authenticated spaces/threads messages |
| LINE | Signed Messaging API Webhook and independent push to user/group/room |
| Mattermost | Authenticated WebSocket events and REST posts, channel/thread |
| Signal | Explicit signal-cli JSON-RPC/SSE service and identity/group send; this is an unofficial Signal client, not an official Bot API |
| IRC | Configured TLS/server connection, channel/private text, auth, PING and reconnect |

Each native plugin implements text receive, durable handoff, delayed independent send, typed configuration/protocol boundaries, and tests. Long connections implement start/stop/recovery. Message Content intents, account permissions, service windows, and external client prerequisites remain explicit platform constraints.

Agents: dot via MCP Events/Tools; Grok via a Routine Webhook carrying text and MCP claim/completion tools. Use corresponding SDKs or strictly checked published schemas. The user explicitly excludes real-account integration for this delivery. Complete local protocol E2E and label real-account support experimental. Do not simulate an account and claim it was verified.

## Shared requirements

- Static validated account/endpoint/binding/sender-allowlist configuration and environment-backed secrets; no admin UI/multi-tenant system.
- Freeze endpoint and reply target at acceptance. Changes to a binding cannot redirect old task results.
- Persist before ACK where controllable. Deduplicate stable source event IDs; do not invent transport redelivery guarantees.
- One active request per endpoint. Authenticated idempotent claim attempts issue a processing token; restarts/timeouts never automatically re-run claimed remote work.
- Result and outbound creation commit atomically. Identical completion replays are idempotent, conflicting finals fail. Agents cannot supply arbitrary reply destinations.
- Retry known temporary failures; preserve unknown external sends for explicit recovery. Persist text chunk progress/identities.
- Interchangeable SQLite/PostgreSQL plugins own transactions and migrations. Resident worker scans persisted due records; no Redis/queue server.
- Independent observability plugin provides redacted JSON logs, bounded metrics, optional tracing. Export failures cannot break messaging. Backlog and worker/connection health are visible.
- CLI provides validate/migrate/run/status/doctor and guarded requeue/recovery. Migrations are explicit. Retention never deletes pending requests or undelivered results.

## Security and excluded features

Authenticate events and agent tools separately; enforce endpoint scope and sender allowlists. Message text grants no authority. Bound request sizes and call durations. Subscription callbacks require authorized HTTPS destinations and protection against private-address/redirect abuse. Secrets/raw payloads/message text stay out of logs by default.

Media, cards, slash commands, streaming, arbitrary proactive agent notifications, attachment storage, multi-tenant SaaS, billing, UI, additional agent platforms, dynamic plugin installation and hot upgrades are excluded. These exclusions do not drop any of the 15 text channels. Unsupported encrypted messages must be rejected/diagnosed, never silently treated as processed text.

## Acceptance

Deliver SDK, core, fifteen native channel packages, dot/Grok, SQLite/PostgreSQL, observability, CLI, Docker/Compose, examples, user/operator/developer guides, license notices and CI. Vitest protects public APIs, protocol, config, migration, security and release behavior. Before every new/changed test, answer the four AGENTS.md questions in a task rationale document.

Required evidence: build/typecheck/lint and default Vitest pass; both storage contract suites run against real databases; local HTTP/socket peers demonstrate production ingest → dispatch → scoped claim → completion → outbound and restart recovery; each channel verifies its own authentication/target/error contracts. Test peers simulate only external services, never Relanox business behavior. Deployment/startup checks are reproducible.

Real accounts and production SLA are not acceptance requirements here. Local tests do not prove live account compatibility or exactly-once external effects. User authorizes master commits/pushes and requires GPT-6.1 Sol subagents, isolated task worktrees, and dependency-ordered parallel execution through completion.