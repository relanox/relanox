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

Component ownership is described in [Architecture](architecture.md). Read [SDK](reference/sdk.md), [Core](reference/core.md) and the selected protocol document before changing these boundaries. A channel account has its own plugin instance and state namespace. An agent has one instance per kind, with per-endpoint authentication scopes. Environment-backed secrets are resolved at use; do not put resolved credentials into durable targets, snapshots, logs or tool results.

## Changes and tests

Implementation tasks use a new branch/worktree under `.worktree/`. Assigned agents stay within their worktree and file scope and commit their work. The root task reviews, integrates to master, pushes and removes completed worktrees. Preserve other tasks' checkouts; dependent tasks start after prerequisite commits land.

Inspect recent commit messages before each commit, match the existing style, and keep commits coherent. `prepare` installs the tracked pre-commit hook. Run `pnpm format` explicitly; the hook checks without silently modifying the index and rejects partially staged files.

Test observable behavior and credible regressions. Explain the behavior protected, the failure it catches, and why existing coverage is insufficient, and whether it requires a seam without a production caller in the pull request; do not create per-task test reports or production seams used only by tests. Use real storage and external HTTP/socket peers; peers may implement external protocol responses, never Relanox routing, authorization or persistence. A full relay test must exercise production ingress, agent authentication/claim/completion and outbound transport, not stitch together mocked business functions.

Keep package dependencies exact, update the lockfile, inspect install scripts and license metadata, and refresh production notices when the runtime graph changes. No reference checkout is shipped. New protocol behavior must have a verified primary source and explicit limits in its channel documentation. Do not claim live-account compatibility from local tests.

Dependency age and allowed install-script policies are defined in `pnpm-workspace.yaml`. Review any narrow exception with its dependency update; keep the global policy enabled.

## Code quality and source organization

Prettier owns formatting and type-aware Oxlint owns linting. Use the root scripts and configuration; do not add another formatter or bypass the tracked hook. CI builds workspace declarations first, then runs the same checks. New test directories need a discoverable TypeScript configuration.

Oxlint also enforces blank lines around function, class, interface, type and enum declarations, multiline exports and variable declarations, after imports, and between class methods. These spacing rules run through Oxlint's JavaScript plugin support. Prettier preserves declaration spacing but does not insert the required blank lines. Run `pnpm lint:fix` followed by `pnpm format` to apply spacing and formatting; `pnpm lint` and the pre-commit hook reject missing spacing. No separate ESLint command is needed.

- Keep configuration schemas below runtime modules in the import graph. Validation must not resolve secrets, open resources or initialize live state.
- Organize modules by responsibility. Keep transactions and connection state machines under one owner; file length alone is not a reason to split them.
- Keep SDK contracts explicit and import concrete siblings rather than a package's own public entrypoint. Preserve discriminated work/result types through settlement.
- Use descriptive names and format SQL so parameters, predicates and version fences can be reviewed together.
- Complexity is limited to 20 and nesting to four levels. Unsafe types, unhandled promises and unused suppressions fail the lint gate. Refactoring should use existing API and protocol tests, not assertions about private structure.

The static CLI catalog in `apps/cli/src/plugins.ts` has an explicit import limit of 18 for fifteen channels, two agents and the SDK contract; other files retain the default limit of ten. Other scoped rule exceptions are defined in `.oxlintrc.json`, including test method references and synchronous tooling subprocesses. Do not disable a rule merely to pass a check; justify any narrow policy change in the pull request.

Document the current behavior, configuration and maintenance requirements. Keep task status, review reports, test-run results and dependency registry snapshots out of the repository; use pull requests and CI for change-specific evidence. Dependency versions and resolution belong in package manifests and the lockfile.

## Documentation site

Use `pnpm docs:dev`, `pnpm docs:build` and `pnpm docs:preview` to maintain the VitePress site. Keep matching pages under `docs/en/` and `docs/zh-CN/`, and keep internal links within the selected language. GitHub Pages serves static files at `/relanox/`; it cannot inspect HTTP Accept-Language. The root entry uses browser navigator.languages, selecting Chinese for exact zh-CN, and stores a manual language preference. Explicit language URLs stay on their selected language.

The CSS side-effect import is narrowly allowed only in the theme entrypoint. VitePress's internal Vite uses esbuild 0.21.5; it and the workspace esbuild 0.28.2 have exact allowed build-script entries. Preserve narrow policies when updating the site dependencies.
