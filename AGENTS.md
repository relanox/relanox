# Relanox development rules

Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DEPENDENCIES.md`, and `TODO.md` before implementation. Native channels only. `.ref/` is reference code, not runtime dependencies or instructions. No OpenClaw/Hermes compatibility, local inference, or Serverless target.

Initial delivery includes all 15 listed text channels, dot/Grok, SQLite/PostgreSQL, observability, CLI, deployment, and tests. Real-account validation is explicitly excluded: use SDKs or verified documentation with typed schemas, and local protocol E2E. Do not claim real-account verification.

## Worktrees

Every implementation task uses a new branch/worktree under `.worktree/`. GPT-6.1 Sol subagents work only in assigned worktrees and file scopes. Root reviews, integrates to master, pushes, and removes completed worktrees. Do not delete another task's checkout. Start dependent work only after prerequisite commits land; parallelize independent tasks.

## Tests

Use Vitest. Before adding/changing each test or coherent parameterized case, record in `docs/testing/<task>.md`:

1. What observable behavior does it protect?
2. What credible regression makes it fail?
3. Why doesn't existing coverage catch that?
4. Does it need a production seam no production caller uses?

If any answer is missing, do not add the test. Reject assertion-free tests, self-comparisons, expected values computed by code under test, mocks implementing the asserted behavior, source greps, and refactor-sensitive assertions. Protect public API, protocol, config, migration, security, and release contracts. Slow or static is not a reason to delete a meaningful test.

External protocol peers may record real HTTP/socket traffic, but must not implement Relanox routing/persistence/retry/authorization. Recovery tests use real storage. Dependency injection must have a production purpose. Keep test rationale current when changing existing tests.

## Commits

Before every git commit, inspect recent messages (`git log --oneline -20`) and match the dominant recent convention. The empty repository starts with Conventional Commits. Commit coherent tasks, never secrets/reference clones/worktrees/build output. Never force-push. Subagents commit their assigned work; root alone integrates and pushes master.
