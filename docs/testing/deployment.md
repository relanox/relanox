# Container release contract

Before implementing the container test:

1. Observable behavior: the built production image runs as an unprivileged user, refuses an unmigrated database, performs explicit migration, serves readiness with the built CLI and native SQLite driver, and restarts on the same persisted volume.
2. Credible regression: pnpm deployment omits a workspace dependency or native binary, the entrypoint points to a source-only file, startup silently migrates, volume permissions prevent SQLite writes, or the health listener fails in the final image.
3. Existing coverage does not build the Linux image or execute its deployed production dependency graph. Unit and local protocol tests cannot detect packaging failures.
4. No new production seam. The test invokes the shipped Docker entrypoint and health endpoint with a credential-free empty configuration. Docker itself is a prerequisite; local runs without an explicitly selected image skip this suite. CI builds that image and explicitly enables the suite, so skipped local checks are not release evidence.

The external fixture contains no accounts or endpoints; it verifies deployment, not messaging. Messaging E2E has a separate rationale and real protocol peers.
