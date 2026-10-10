# Observability test rationale

Before implementing each group, the following answers admit its tests.

## Redacted log boundary and backpressure

1. Protect JSON logging that retains generated correlation IDs and known events but never arbitrary payloads, errors, credentials or caller-defined fields; slow collectors cannot grow queues without bound and failed collectors cannot throw into business calls.
2. Passing raw fields/error objects to Pino leaks a token or message; continuing writes after false queues indefinitely; uncaught destination errors break ingest.
3. SDK typing cannot stop cast/untrusted runtime objects; metrics and trace tests do not inspect real JSON stream output or stdout flow control.
4. No unused production seam: optional Writable destination supports a production collector instead of stdout. Tests use Node PassThrough and actual Writable stream IO, not a mock implementing redaction.

## Metrics, disabled facade and configuration

1. Protect exact counter/gauge/histogram semantics, independent registries, finite labels and a hard series bound, management Web Request/Response handling, disabled signals, and explicit bounded tracing configuration.
2. Using histograms for backlog prevents decreasing snapshots; accepting request labels leaks identities/unbounded series; global registry duplicates construction; accidental env tracing sends data without opt-in.
3. Log tests cannot examine Prometheus wire output; compile-time labels do not enforce hostile runtime input or unknown metric names.
4. No test-only seam: consume public setup/observe/metrics/config/flush/shutdown and the SDK disabled facade.

## OTLP collector and lifecycle

1. Protect opt-in real HTTP export, stable serializable stage contexts, parent correlation, end-once semantics, safe attributes, independent concurrent instances, bounded flush/shutdown and failed collector isolation.
2. Global provider registration redirects one instance to another collector; missing flush loses finished spans; repeated end duplicates exports; rejected HTTP export propagates a business failure or hangs exit.
3. Metrics/log coverage never exercises external trace transport or parent IDs after serialization.
4. No unused seam: a local HTTP server records actual OTLP traffic and returns a protocol response; it does not implement any Relanox behavior. Tests assert wire JSON, not OTel internals.

Sampling and hung-peer cases are part of the OTLP group: a ratio-zero runtime must retain correlation without traffic; a stalled collector must not hang process lifecycle. Regressions include ignoring explicit sampleRatio and awaiting exporter completion without a deadline. Successful/error-response collector cases do not exercise either behavior. Both use the same production configuration and real local HTTP peer; no additional seam is introduced.

Known core error-code case extends the admitted redaction group before changing it: preserve actionable finite `call_timeout` while excluding raw caller error text. Regression is a category-only logger that silently drops the core's diagnostic code. Previous arbitrary-error rejection does not prove an allowed code survives. No new seam is required.
