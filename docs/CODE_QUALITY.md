# Code quality gates

Oxfmt owns formatting; Oxlint owns linting. The former Biome dependency/configuration is removed so two formatters cannot rewrite each other's output. Versions are pinned in package.json and pnpm-lock.yaml: Oxlint 1.87.0, Oxfmt 0.72.0 and oxlint-tsgolint 7.0.2004. These are development tools, not runtime dependencies.

## Commands and enforcement

- `pnpm format`: format supported source, config, documentation and workflow files.
- `pnpm format:check`: check without changing files.
- `pnpm lint`: all enabled Oxlint rules, including type-aware rules; any warning or unused suppression fails.
- `pnpm lint:fix`: safe automatic lint fixes; review the diff and run typecheck/tests afterwards.
- `pnpm check`: format, lint, full source/test typecheck, and Vitest.
- `pnpm prepare`: install the tracked `.githooks` path. Normal pnpm installation runs this automatically; a source archive without Git skips hook installation.

Pre-commit runs format and lint checks across the checkout. It never rewrites or stages files. Partially staged files are rejected explicitly because checking only the working copy could hide a bad staged revision. Finish staging the reviewed content, or restore the unstaged portion, then retry. Build workspace packages before type-aware checking a fresh checkout (`pnpm build`). CI builds first and runs the same gates plus real PostgreSQL tests. CI remains authoritative even if a local hook is bypassed.

The hook is verified by an actual disposable Git repository: malformed formatting is rejected, an unhandled Promise is rejected by type-aware linting, partial staging is rejected without changing the index, and a clean commit succeeds. This works with Node 26's native TypeScript stripping; no additional hook manager or shell interpolation of filenames is needed.

## Source organization

Organize code around responsibilities that change together. Package `index.ts` files declare the public API or compose the package runtime; they should not also contain configuration schemas, protocol codecs, SQL operations and transport state machines. Internal modules import their concrete siblings directly rather than importing their own public entrypoint.

- Keep configuration shape, cross-reference validation and resource acquisition distinct. Schema parsing must not resolve secrets, open databases or register live handlers. Name schema primitives by their domain meaning, such as configuration IDs and platform IDs.
- Keep schema and configuration modules below transport/runtime modules in the import graph. Reusing an ID schema must not import socket clients, HTTP handlers or process assembly. Runtime connection inventory belongs to setup, not configuration validation; populate the full inventory before invoking any setup callback.
- Keep transaction bodies and connection/session state under one owner. Extract a module when it owns a complete operation or lifecycle; do not split one atomic transition across generic repositories or callbacks solely to shorten a file.
- Use descriptive record, query and protocol names in nontrivial flows. Format SQL so predicates, parameters and version fences can be reviewed together. Comments explain authority, ordering, recovery and ownership constraints rather than restating statements.
- Keep public contracts explicit and stable. SDK contracts have domain files and one public export entrypoint; runtime implementation stays in core or the concrete plugin. New internal exports do not imply new package subpath APIs.
- Preserve discriminated task/result types through execution and settlement. A cast that reconnects a dispatch/send outcome to its work kind hides a broken type boundary; construct the corresponding settlement in its narrowed branch.
- Prefer existing public API and protocol regression tests for refactoring. Do not add tests asserting filenames, import layout, private helper calls or the new module structure.

There is no arbitrary maximum file length. A cohesive session state machine may remain longer than a schema module; a short forwarding module is not automatically an improvement. Review ownership, dependency direction and how many files a behavior change requires. The current source map is documented in [architecture](ARCHITECTURE.md#source-organization).

## Rule policy

All available rules in correctness, suspicious, pedantic, performance and style categories are errors for the TypeScript, Unicorn, Oxc, Import, Promise, Node, Vitest and JSDoc plugins plus ESLint core. Explicit restrictions include no `any`, non-null assertion, unsafe assignment/call/member/argument/return, floating/misused Promise, eval/new Function, console, var, parameter reassignment or loose equality. Exhaustive switches, explicit braces, one declaration per statement, complexity at most 20 and nesting depth at most 4 are enforced. Nursery rules and frontend-only plugins are not appropriate to this Node service.

The explicit exceptions in `.oxlintrc.json` are reviewed policy, not a baseline of ignored findings:

| Rule family                                                                | Reason for the exception                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Named/default/grouped/last exports, Node imports                           | The SDK and plugins deliberately expose named APIs and use Node builtins.                                                                                                                                                                        |
| Alphabetical keys/imports, function style, literal casing                  | Oxfmt owns presentation. Protocol keys retain meaningful grouping. Numeric casing must not conflict with Oxfmt.                                                                                                                                  |
| Blanket ternary/continue/negated-condition/destructuring bans              | Simple expressions and guards are allowed; nested ternaries remain forbidden.                                                                                                                                                                    |
| Magic numbers, identifier length, function/file/statement/parameter counts | Protocol constants, SQL and plugin factory objects make these arbitrary size counts poor correctness gates. Per-function complexity and nesting are enforced instead.                                                                            |
| Require-await and readonly parameter types                                 | Async SDK contracts may complete synchronously, and drivers/socket interfaces require mutable types. Floating promises and unsafe types remain prohibited.                                                                                       |
| Generic single-use parameter/type-assertion restrictions                   | Typed durable codecs deserialize known versioned records; SDK config validation bridges schema output and exact optional properties. Unchecked `any` propagation remains an error.                                                               |
| Null/structuredClone restrictions                                          | JSON persistence and protocols require null and JSON serialization semantics, which differ from structuredClone.                                                                                                                                 |
| Promise constructor/callback/then bans and no-await-in-loop                | Socket callbacks need bridging and cancellation handlers; FIFO transactions and sends intentionally await sequentially.                                                                                                                          |
| JSDoc parameter/return boilerplate                                         | TypeScript signatures supply these types; meaningful API semantics live in SDK documentation.                                                                                                                                                    |
| Test title/import/hook/placement/expect-count/style preferences            | Explicit Vitest imports and real resource lifecycle hooks are required. Parameterized shared contracts, rejection branches and several related assertions are valid. Avoid mechanically adding assertion counts or rewriting exact expectations. |
| Boolean matcher alternatives                                               | Exact boolean matchers win over contradictory truthy/falsy preferences.                                                                                                                                                                          |
| Conditional test expectations                                              | Shared backend contracts branch on explicit outcomes; missing records still throw and fail. Test admission rules independently prohibit assertion-free or self-comparing tests.                                                                  |
| Test unbound methods; tooling sync subprocesses                            | Vitest inspects recorded method references without calling them. Short Git hook scripts intentionally wait for subprocess exit. These exceptions apply only to those file scopes.                                                                |

Nullable primitive guards are allowed; truthiness of `any` is still an error. Separate type-only imports are accepted. Do not add a file-wide disable or lower a category just to pass. Fix the implementation or document a narrow, justified rule exception. All worktrees and future plugins use the same root configuration.

The static CLI plugin catalog (`apps/cli/src/plugins.ts`) has a scoped dependency-count limit of 18: fifteen channel factories, two agent factories and the SDK contract. It is the composition root for these implementations. Splitting that catalog into nominal HTTP/connection files hid the same dependencies and misrepresented plugins whose transport is configured at runtime. The dependency-count rule remains enabled; other files keep the default limit of ten, and expanding the catalog requires reviewing its explicit limit.

Source references: [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config), [type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware), [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config).
