# Dependency refresh

The existing SQLite lock peer now checks that `process.disconnect` exists before calling it, matching Node 26's optional IPC API types. Assertions and test scenarios are unchanged.

1. Protects CLI shutdown and recovery while a separate process holds a real SQLite write lock.
2. A child process that fails to release the lock or disconnect can hang shutdown or recovery.
3. Existing cross-process lock tests already cover this behavior; no additional test is needed for the type guard.
4. No production seam is added; the peer uses Node's real SQLite and IPC APIs.
