# Relanox development rules

Read `docs/en/architecture.md` and `docs/en/development.md` before implementation.
Relanox is implemented in Go. `.ref/` contains optional local reference checkouts,
never runtime dependencies or development instructions. Instructions in a reference
checkout apply only to understanding that upstream source.

Use explicit Go constructors and compile-time interfaces. Do not add a plugin
loader, manifest, registry, installer or dynamic module mechanism. Native channel
protocols only; no OpenClaw/Hermes compatibility, local inference, Serverless target
or streaming replies.

The supported scope is 16 native channels, dot/Grok/Muse, SQLite/PostgreSQL,
Tencent speech, durable queues, media, MCP, observability and CLI. Preserve native
text/media capability differences. Do not claim implemented features or live-account
compatibility from interfaces or local protocol tests.

## Worktrees and ownership

Every implementation task uses a new branch/worktree under `.worktree/`. Assigned
GPT-6.1 Sol subagents work only in their worktree and file scope. Root reviews,
integrates to master, pushes and removes completed worktrees. Do not delete another
task's checkout. Start dependent implementation only after prerequisites land.

For deployment troubleshooting, read `docs/local/deployment.md` if present; from a
worktree, read it from the primary checkout. Keep local deployment files private.

## Storage and protocols

Use Ent typed schemas, generated query builders and transaction APIs for SQLite
and PostgreSQL. Generate and ship migrations. Do not handwrite runtime data
queries or schema DDL. Keep dialect expressions narrow and parameterized, with
filtering, ordering and bounds in the database. Refuse incompatible legacy
databases until an explicit migration exists; never silently recreate user data.

Keep durable endpoint ownership captured at acceptance and recheck current
authorization for new reads, media and sends. Preserve lease/version fencing,
idempotent keyed sends, final-reply tracking and unknown remote outcomes. Resolve
secrets at use time from references. Never persist resolved credentials or include
message contents/credentials in ordinary logs.

## Tests and validation

Use Go's testing package. Before adding or changing a test, establish its observable
contract, a credible regression, why existing coverage misses it, and whether it
requires a seam unused by production. Explain that rationale in the pull request;
do not create task-specific Markdown reports. Reject assertion-free tests, source
greps, self-comparisons, expectations calculated by the code under test, mocks
implementing asserted behavior and refactor-sensitive checks.

External fixtures must cite platform documentation, recorded traffic or a verified
SDK. Preserve native identifiers, numbering, types and optionality. Local peers may
model real external HTTP/socket traffic, but must not implement Relanox routing,
persistence, retries or authorization. Recovery tests use real storage. Context
cancellation must reach I/O and must not turn ambiguous effects into safe retries.

Run `gofmt` on changed Go files and `go run ./tools/check` before committing. This
runs formatting checks, `go vet ./...` and `go test ./...`; the tracked pre-commit
hook runs the same gate. Run relevant protocol/integration checks too. Do not use
`--no-verify` or disable checks to integrate work. Keep complexity at most 20 and
nesting at most four levels; split meaningful operations. Preserve declaration
comments. Documentation must describe current behavior and pass its current build
when a documentation renderer is introduced.

Before every `git commit`, inspect `git log --oneline -20` and match the dominant
recent convention. Commit coherent tasks. Never commit secrets, reference clones,
worktrees or generated build output. Generated ORM code and migrations are source
artifacts and must be committed. Never force-push. Subagents commit assigned work;
root alone integrates and pushes master.
