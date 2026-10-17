# Contributing

This guide helps you prepare a change, run the checks and submit it for review. For account setup and running the service, start with [Quick start](getting-started.md).

## Set up a checkout

Use Node 26.11.1 and pnpm 12.11.2, as specified in `package.json`. Create a branch and a separate worktree under `.worktree/` for each implementation task. For example, from an existing checkout:

```sh
git worktree add .worktree/my-change -b my-change
cd .worktree/my-change
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

Build before type checking or linting: workspace packages use compiled declarations. `pnpm check` runs formatting checks, lint, type checking and Vitest. Installation also sets up the tracked pre-commit hook.

Native plugins are workspace development dependencies of the CLI, so `pnpm install --frozen-lockfile` and `pnpm build` retain the standard source workflow. The CLI package can be packed independently; production distributions must install or assemble the native packages they need. Packaging support does not mean a package version is already available on npm.

After building, `pnpm exec node scripts/assemble-plugins.mts <destination> "channel-wecom channel-matrix"` assembles the production CLI and the selected native packages. Docker uses the same script. Each isolated `pnpm deploy` permits unused workspace patches because its production graph may omit WeCom; required patches still have to apply. Ordinary workspace installation keeps the stricter unused-patch check.

To work on a plugin outside the normal workspace resolution, build it and set `plugins.load.paths` to its package directory in the test configuration. Relative override paths resolve beside that configuration file. Override packages need a `relanox` manifest and compiled `dist/plugin.js` exporting `createPlugin`; see [Package a native plugin](reference/sdk.md#package-a-native-plugin). Duplicate identities or broken overrides fail instead of using an installed copy. Rebuild and restart after edits.

## Make a focused change

Read [How messages reach your Agent](architecture.md) and the guide for the integration you are changing. For SDK work, read [Build an integration](reference/sdk.md) and inspect the exported types. Keep each change focused on an observable behavior.

Keep secrets as environment references and out of saved messages, logs and tool responses. Validate configuration without opening connections. Use the scoped plugin hosts for message and state operations. Preserve comments alongside the code they explain.

If you update dependencies, keep versions exact, update the lockfile, review install scripts and licenses, and refresh shipped notices when production dependencies change. Review narrow exceptions in `pnpm-workspace.yaml` rather than disabling the shared install policy.

Storage queries use Drizzle’s typed schemas, query builders and transaction APIs. Generate schema migrations from those schemas and ship them with the storage packages. Do not handwrite runtime data queries or schema DDL. Keep database-specific expressions and function calls narrow and parameterized, and preserve database filtering, ordering and limits.

Run `pnpm --filter @relanox/storage-sqlite db:generate` or `pnpm --filter @relanox/storage-postgres db:generate` after changing a storage schema. Review the generated migration before committing it. PostgreSQL supports a configured schema through `search_path`; table and foreign-key references must resolve there rather than be fixed to `public`. During development, regenerate the initial schema and its snapshot when the schema changes; no upgrade path for older development databases is maintained. Use a fresh disposable database when switching schema versions. Initialization and reopening the same schema remain idempotent.

## Choose tests that catch a real regression

Use Vitest. Before adding or changing a test, explain in the pull request:

- What behavior does the test protect?
- What credible regression would make it fail?
- Why does existing coverage not catch that regression?
- Does it require a production interface that no production caller uses?

Use real storage for recovery tests. Local HTTP or socket peers can model the external platform's responses, but must not implement Relanox's routing, permissions, persistence or retries. Test public behavior rather than private code structure. New test directories need a discoverable TypeScript configuration for type-aware linting.

Build external response fixtures from platform documentation, a recorded response or a verified SDK implementation. Record the source beside the fixture. Keep native identifiers, numbering, field types and optional fields distinct from local array positions. When references disagree, verify the response before changing the contract. A peer that mirrors Relanox’s assumptions cannot establish platform compatibility.

For PostgreSQL tests, set `RELANOX_TEST_POSTGRES_URL` to a disposable database whose user can create and drop schemas. The suite uses isolated schemas and removes them. Without this setting, PostgreSQL tests are skipped. In PowerShell:

```powershell
$env:RELANOX_TEST_POSTGRES_URL = 'postgresql://relanox:password@127.0.0.1:5432/relanox_test'
pnpm test
```

To test the production container, build `docker build -t relanox:test .`, set `RELANOX_TEST_CONTAINER_IMAGE=relanox:test` in your shell, then run `pnpm test`. This checks the built image's startup, readiness and restart behavior.

## Format and verify

Use the root scripts and shared configuration. Prettier formats the code; Oxlint also fixes required spacing between declarations and class methods.

```sh
pnpm lint:fix
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Keep complexity at most 20 and nesting at most four levels. Split meaningful operations when needed. Do not bypass lint rules or the pre-commit hook to land a change.

## Update the documentation

Keep English and Simplified Chinese pages aligned, and link within the reader's chosen language. Explain setup, expected results and troubleshooting in terms useful to the person using the feature.

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

Run `pnpm docs:build` before committing documentation changes. The public site is [relanox.github.io](https://relanox.github.io/). Its deployment repository checks for source updates every 30 minutes; maintainers can trigger its Documentation workflow for an immediate update.

The connection configurator is a client-side Vue component. `pnpm typecheck` checks its templates with `vue-tsc` and the pinned `typescript-vue` compiler alias; Vue's checker requires the JavaScript compiler API that TypeScript 7 no longer exports. Runtime packages continue using TypeScript 7. Configurator tests pass generated JSON through the production configuration validator without connecting to platform accounts.

## Commit and submit

Before every commit, inspect `git log --oneline -20` and follow the recent commit style. Run formatting, lint, type checking and relevant Vitest checks before committing; include the documentation build for documentation changes. Stage a coherent change and let the tracked hook pass. Keep secrets, reference clones, worktrees and build output out of commits.

Use the pull request to explain the resulting behavior, test rationale and validation. Keep change-specific status reports out of the repository. Record real-account validation separately from local protocol tests. CI checks build quality, Linux and Windows tests, and the production container.
