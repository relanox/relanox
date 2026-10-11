# Operations audit test rationale

## Reviewed coverage and local evidence

- Observability: reviewed `plugins/observability-standard` and `docs/OBSERVABILITY.md` for bounded logging, lifecycle completion, finite diagnostic fields, metric cardinality, OTLP export isolation and management-handler behavior. The regressions below protect the confirmed fixes.
- Deployment and packaging: reviewed `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/empty.example.json`, `deploy/prometheus-alerts.yml`, `tests/deployment/container.test.ts`, workspace package manifests and the CLI production deployment layout. Checked the non-root runtime, read-only filesystem and data volume, schema initialization, private management health check, restart smoke coverage, production dependency selection and license-notice inclusion.
- CI and tooling: reviewed `.github/workflows/ci.yml`, root quality scripts, `.githooks/pre-commit`, `scripts/install-hooks.mts`, `scripts/pre-commit.mts` and `tests/tooling/hooks.test.ts`. CI builds before type-aware checks, supplies real PostgreSQL, builds the image and enables the container smoke test. The deletion-only hook regression has its own rationale in `audit-hooks.md`.
- Configuration and operating instructions: reviewed `.env.example`, both `examples/relanox.*.json` configurations, `README.md`, `docs/OPERATIONS.md`, `docs/DEVELOPMENT.md`, `docs/CODE_QUALITY.md` and the observability plugin README against the implemented build, initialization, startup, health, backup and shutdown flow.
- Local results: frozen-lockfile installation and workspace build succeeded. `node apps/cli/dist/main.js validate --config examples/relanox.all-channels.json` returned `ok: true` with 15 accounts and 2 endpoints; validation of `examples/relanox.sqlite.json` returned `ok: true` with 1 account and 1 endpoint. `docker compose config --no-env-resolution --quiet` passed; this checks Compose structure without resolving a local `.env` file.
- Verification limits: the local Docker daemon was unavailable (`dockerDesktopLinuxEngine` named pipe missing), so the container runtime test was skipped locally. The CI image build and enabled container smoke test are authoritative for container execution; their final integrated result must be checked separately. This audit does not claim real-account validation.

## Asynchronous collector flush and shutdown

1. Observable behavior: `flush` and `shutdown` wait for accepted log writes to finish, including writes below the collector's high-water mark, while respecting the lifecycle deadline. The caller can safely release its collector after shutdown.
2. Credible regression: treating `Writable.write()` returning true as completion resolves lifecycle calls before the asynchronous write callback, losing accepted logs on collector teardown.
3. Coverage gap: existing logging coverage only exercises high-water-mark backpressure and collector failure, not successful asynchronous writes that never emit `drain`.
4. Production seam: no new seam. The public `logDestination` option already supports production-owned collector streams; the test uses an actual Node Writable and controls only its I/O completion.

## Native diagnostic normalization

1. Observable behavior: current native channel events and fixed diagnostic codes produce meaningful documented event/error categories in JSON logs; arbitrary provider text remains excluded.
2. Credible regression: the native plugins emit `channel_*` events, `receive` operations, and fixed codes that the original standard vocabulary silently strips, leaving only an uninformative `operation.failed` record.
3. Coverage gap: existing boundary tests use the documented generic vocabulary and hostile strings but never submit the exact constants emitted by native plugins.
4. Production seam: none. Exercise the public observability facade and real JSON output with current native emitter constants, including unknown prefix lookalikes to protect strict sanitization.
