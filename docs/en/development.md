# Development

Use Go 1.27.2 and a separate branch/worktree under `.worktree/` for every implementation
task. Read [architecture](architecture.md) and root [AGENTS.md](../../AGENTS.md).

```sh
git config core.hooksPath .githooks
go run ./tools/check
```

Install the official golangci-lint binary at the version pinned in
`.golangci-lint-version` in the ignored `bin/` directory or on `PATH` before running
the gate (`bin/` takes precedence). Follow the
[upstream installation guide](https://golangci-lint.run/docs/welcome/install/local/).
CI installs the same binary version. The linter is separate from `go.mod`, so its
dependencies do not change the application dependency graph.

The tracked hook runs the same gate: gofmt validation, complexity at most 20,
nesting at most four levels, `go vet ./...`, golangci-lint and `go test ./...`.
Lint checks unchecked errors, ineffective assignments, unused code and static
correctness/simplification rules. Generated files follow their generator;
handwritten production and test code are both checked. Any `nolint` directive must
name its linter and explain the exception. Format changed files with `gofmt -w`
first. Keep native dependencies pinned, review their licenses and retain
attribution when porting protocol code.
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
gap in existing coverage, and whether it needs a seam unused by production; explain
that rationale in the pull request. External response fixtures require a platform
documentation, recording or verified SDK source. Local HTTP/socket peers emulate
only external protocols. They cannot implement the behavior being tested. Local
protocol checks do not establish compatibility with a real account.

## Executable and documentation

```sh
go build -trimpath -o bin/relanox ./cmd/relanox
go run ./tools/docs
```

The documentation renderer uses the pinned Go Markdown dependency, validates local
Markdown links and writes `docs/site`. Keep English and Chinese operator pages
aligned with actual native options. Documentation changes must pass this build.

The [published documentation](https://relanox.github.io/) is built by this
repository's `Documentation` workflow on documentation changes to `master`, or
by manual dispatch. It sends a `documentation` repository dispatch to
`relanox/relanox.github.io`, whose workflow builds and deploys the current source.
The `DOCS_DISPATCH_TOKEN` Actions secret needs access only to that site repository,
with Contents read/write permission for repository dispatch. There is no scheduled
source polling. The site's `source-commit.txt`
records the exact source revision. The same workflow maintains redirects from
`/relanox/`, including URLs used before the Go migration.

Deployment work must also read private `docs/local/deployment.md` from the primary checkout if present.

## Ent schema and migrations

SQLite and PostgreSQL share `internal/storage/ent/schema/records.go`, generated
Ent query builders and transaction APIs. The pinned generator is a Go tool in
`go.mod`; use the existing directive, which enables `sql/upsert`:

```sh
go generate ./internal/storage/...
git diff --exit-code -- internal/storage/ent
```

When intentionally changing the schema, review and commit the generated changes
and migrations under `internal/storage/migrations/sqlite` and `postgres`. Generate
migration statements using `internal/storage/cmd/migrations` against an empty
development database. Do not edit generated schema SQL or add handwritten runtime
queries. A database format change requires an explicit migration policy; the
runtime must continue refusing incompatible existing stores.
