# Development

Use Node 26.11.1 and the exact pnpm version in `packageManager`. Install dependencies, then build before checking types or running type-aware lint: workspace exports resolve compiled declaration files.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` runs formatting, Oxlint, type checking and Vitest. For real PostgreSQL coverage, provide `RELANOX_TEST_POSTGRES_URL` pointing to a disposable database whose user can create/drop schemas. The PostgreSQL suite uses isolated schemas and removes them. Without this variable, that suite is skipped; Linux CI supplies PostgreSQL 18.6, while Windows CI runs SQLite and the local protocol suites. No production database or live channel credentials are needed.

```sh
# POSIX shell; use $env:RELANOX_TEST_POSTGRES_URL in PowerShell.
RELANOX_TEST_POSTGRES_URL=postgresql://relanox:password@127.0.0.1:5432/relanox_test pnpm test
```

For the image contract, first build `docker build -t relanox:test .`, then run Vitest with `RELANOX_TEST_CONTAINER_IMAGE=relanox:test`. It executes the final production image, automatic schema initialization, readiness and restart. CI builds and loads the image with Buildx before running this suite. Local skips are not evidence that a database or image passed.

CI runs independent build/quality, Linux/Windows test, and production container jobs on pushes to master, pull requests and manual dispatch. Every job installs the frozen lockfile; package-store and container-layer caches accelerate installation without replacing verification. The container job also validates Compose. Actions and base/service images are pinned to immutable commits or digests; Dependabot proposes GitHub Actions and Docker updates weekly. The workflow uses a read-only repository token, does not retain checkout credentials and cancels superseded runs on the same branch or pull request. Images are built for verification only, with no registry credentials or publication step.

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

pnpm 12 retains its default release-age policy. The workspace exempts only the reviewed, already-pinned `oxlint-tsgolint` platform packages at `7.0.2004` and `process-warning@5.1.1`; other fresh releases remain subject to that policy. Dependency build scripts are allowed only for `esbuild@0.28.2`, whose install script validates its pinned executable. These exact exceptions are recorded in `pnpm-workspace.yaml`; do not disable the supply-chain policy globally when updating dependencies.
