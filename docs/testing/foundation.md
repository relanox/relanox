# Foundation test admission

T01 adds no runtime tests. Pure TypeScript interface assertions and no-op assertions would not protect observable messaging, persistence, authorization, or release behavior and are intentionally excluded. Build and typecheck verify the executable contract; lint checks source/tooling. Runtime storage, public core, platform protocol, observability and release tests will be admitted in their respective task rationale documents before implementation.

Vitest discovery was executed with no test files in this documentation/SDK-only baseline. It correctly exits 1 rather than hiding missing coverage with passWithNoTests. The later integration baseline must pass real tests. No claim is made that tests passed in T01.
