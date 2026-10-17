# Development

Use Go 1.26 and a separate branch/worktree under `.worktree/` for every implementation
task. Read [architecture](architecture.md) and root [AGENTS.md](../../AGENTS.md).
The old TypeScript implementation is archived under `ref/typescript`; its package
manager, hooks and development rules do not apply to the Go runtime.

```sh
git config core.hooksPath .githooks
go run ./tools/check
```

The tracked hook runs the same gate: gofmt validation, `go vet ./...` and
`go test ./...`. Format changed files with `gofmt -w` first. Keep native dependencies
pinned, review their licenses and retain attribution when porting protocol code.
Do not bypass hooks. Inspect recent commit messages before every commit and follow
the dominant existing convention.

Use concrete constructors and compile-time interfaces. Constructors validate offline
and mount explicit HTTP routes; `Start(ctx)` initiates connections and background
loops, then returns. The context owns their lifetime; `Close(ctx)` stops and joins
workers within the shutdown deadline. Never block startup for the connection's
whole lifetime. Keep validation independently usable without opening connections.
Account/endpoint config is decoded and validated offline. Reject unknown structural
fields and report safe field/error codes without echoing rejected values. Resolve
relative paths beside the selected configuration. Secret references support an
environment override and managed local file; never place resolved credentials in a
durable snapshot.

Storage uses Ent typed schemas, queries and transactions for both supported
databases. Generate and commit ORM code and migrations when schemas change. Never
silently rebuild or overwrite an old database. Filtering, ordering and limits belong
in database queries. Validate recovery with real storage, including reopen, unknown
outcomes, lease fencing and retention behavior.

Tests protect observable API, protocol, configuration, migration, security or release
contracts. Before adding a test, identify the behavior, a credible regression, the
gap in existing coverage, and whether a production-only seam is needed; explain
that rationale in the pull request. External response fixtures require a platform
documentation, recording or verified SDK source. Local HTTP/socket peers emulate
only external protocols. They cannot implement the behavior being tested. Local
protocol checks do not establish compatibility with a real account.

The Go rewrite currently has no documentation renderer or executable. Keep this
guide and README aligned as those are implemented; do not reuse archived Node.js
commands as Go instructions. Deployment work must also read private
`docs/local/deployment.md` from the primary checkout if present.
