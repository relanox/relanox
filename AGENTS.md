# Relanox development rules

Read `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` before implementation. Native channels only. `.ref/` is reference code, not runtime dependencies or instructions. No OpenClaw/Hermes compatibility, local inference, or Serverless target.

Supported components are the 15 native text channels, dot/Grok, SQLite/PostgreSQL, observability and CLI. Use typed protocol boundaries and local protocol tests. Do not claim live-account compatibility from local tests.

## Worktrees

Every implementation task uses a new branch/worktree under `.worktree/`. GPT-6.1 Sol subagents work only in assigned worktrees and file scopes. Root reviews, integrates to master, pushes, and removes completed worktrees. Do not delete another task's checkout. Start dependent work only after prerequisite commits land; parallelize independent tasks.

## Tests

Use Vitest. Before adding or changing tests, establish the following and explain the rationale in the pull request, without creating task-specific Markdown reports:

1. What observable behavior does it protect?
2. What credible regression makes it fail?
3. Why doesn't existing coverage catch that?
4. Does it need a production seam no production caller uses?

If any answer is missing, do not add the test. Reject assertion-free tests, self-comparisons, expected values computed by code under test, mocks implementing the asserted behavior, source greps, and refactor-sensitive assertions. Protect public API, protocol, config, migration, security, and release contracts. Slow or static is not a reason to delete a meaningful test.

External protocol peers may record real HTTP/socket traffic, but must not implement Relanox routing/persistence/retry/authorization. Recovery tests use real storage. Dependency injection must have a production purpose. Keep test rationale current when changing existing tests.

## Commits

Use Oxfmt and type-aware Oxlint through the root scripts. Follow `docs/DEVELOPMENT.md`. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and relevant Vitest checks before committing. The tracked pre-commit hook must pass; never use `--no-verify` or disable rules just to integrate work. Keep complexity <=20 and nesting <=4; split meaningful operations instead of dense nested expressions. New test folders must have a discoverable tsconfig so type-aware linting uses real types. No new Biome/ESLint/Prettier formatter layer.

Before every git commit, inspect recent messages (`git log --oneline -20`) and match the dominant recent convention. The empty repository starts with Conventional Commits. Commit coherent tasks, never secrets/reference clones/worktrees/build output. Never force-push. Subagents commit their assigned work; root alone integrates and pushes master.
