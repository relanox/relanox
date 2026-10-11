# Development

Use Node 24 and the exact pnpm version in `packageManager`. Install dependencies, then build before checking types or running type-aware lint: workspace exports resolve compiled declaration files.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` runs formatting, Oxlint, type checking and Vitest. For real PostgreSQL coverage, provide `RELANOX_TEST_POSTGRES_URL` pointing to a disposable database whose user can create/drop schemas. The PostgreSQL suite uses isolated schemas and removes them. Without this variable, that suite is skipped; CI always supplies PostgreSQL 16. No production database or live channel credentials are needed.

```sh
# POSIX shell; use $env:RELANOX_TEST_POSTGRES_URL in PowerShell.
RELANOX_TEST_POSTGRES_URL=postgresql://relanox:password@127.0.0.1:5432/relanox_test pnpm test
```

For the image contract, first build `docker build -t relanox:test .`, then run Vitest with `RELANOX_TEST_CONTAINER_IMAGE=relanox:test`. It executes the final production image, automatic schema initialization, readiness and restart. CI performs both commands. Local skips are not evidence that a database or image passed.

## Boundaries

- `packages/sdk` defines the async Channel, Agent, Storage and Observability contracts.
- `packages/core` validates routing/authorization, constructs scoped hosts and processes persisted due work. It does not create listeners, own a timer or import concrete plugins.
- `plugins/channel-*` validate platform protocols and deliver to frozen targets; `plugins/agent-*` authenticate hosted-agent requests and dispatch notifications/text. Neither owns a second business queue.
- Storage plugins implement the documented atomic transactions and durable claim/lease semantics. Changes to those rules require the same shared contract against both real backends.
- `apps/cli` assembles concrete plugins, normalizes Node HTTP requests, controls startup/shutdown and runs the worker. Management routes use a separate loopback listener.

Read [SDK](SDK.md), [Core](CORE.md) and the selected protocol document before changing these boundaries. A channel account has its own plugin instance and state namespace. An agent has one instance per kind, with per-endpoint authentication scopes. Environment-backed secrets are resolved at use; do not put resolved credentials into durable targets, snapshots, logs or tool results.

## Changes and tests

Follow [AGENTS.md](../AGENTS.md) and [code quality rules](CODE_QUALITY.md). Use a fresh task worktree, inspect recent commit messages before each commit, and keep commits coherent. `prepare` installs the tracked pre-commit hook. Run `pnpm format` explicitly; the hook checks without silently modifying the index and rejects partially staged files.

Before adding or changing tests, record the four admission answers in `docs/testing/<task>.md`. Test observable behavior and credible regressions. Use real storage and external HTTP/socket peers; peers may implement external protocol responses, never Relanox routing, authorization or persistence. A full relay test must exercise production ingress, agent authentication/claim/completion and outbound transport, not stitch together mocked business functions.

Keep package dependencies exact, update the lockfile, inspect install scripts and license metadata, and refresh production notices when the runtime graph changes. No reference checkout is shipped. New protocol behavior must have a verified primary source and explicit limits in its channel documentation. Do not claim live-account compatibility from local tests.
