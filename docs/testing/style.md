# Style and commit gate validation

The existing behavioral tests keep their original admission and expected outcomes. Formatting, explicit braces, equivalent expressions, typed protocol decoding, and callback cleanup do not add a new test case. No business mock or test-only production seam is introduced. Their original assertions must continue to pass against SQLite, PostgreSQL, HTTP collectors, and public core APIs.

Before adding the commit-gate regression:

1. Observable behavior: a real Git commit is rejected for invalid formatting, an unsafe/floating Promise, or partially staged checked content; a clean commit succeeds without rewriting developer files.
2. Credible regression: a non-executable/misconfigured hook, ignored child exit code, incomplete lint configuration, or auto-staging changes would defeat the gate.
3. Existing storage/core/protocol tests never execute Git hooks or the development tools and cannot catch this.
4. No production seam: create a disposable Git repository with the actual tracked hook/config/script and execute normal Git commits and installed Oxc binaries. No simulated lint results.
