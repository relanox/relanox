import type { Writable } from "node:stream";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";
import type {
  LogFields,
  MetricLabels,
  Observability,
  ObservabilityPlugin,
  ObservabilityRuntime,
  Span,
  TraceContext,
} from "@relanox/sdk";
import pino from "pino";

const channels = [
  "telegram",
  "discord",
  "slack",
  "feishu",
  "wecom",
  "dingtalk",
  "qq",
  "msteams",
  "whatsapp",
  "matrix",
  "googlechat",
  "line",
  "mattermost",
  "signal",
  "irc",
];
const agents = ["dot", "grok"];
export const operations = [
  "ingest",
  "dispatch",
  "claim",
  "complete",
  "fail",
  "send",
  "storage",
  "http",
  "worker",
  "connection",
  "recovery",
  "retention",
  "startup",
  "shutdown",
] as const;
export const events = [
  "inbound.accepted",
  "inbound.duplicate",
  "inbound.rejected",
  "dispatch.completed",
  "claim.completed",
  "complete.completed",
  "fail.completed",
  "delivery.completed",
  "retry.scheduled",
  "delivery.unknown",
  "connection.changed",
  "worker.completed",
  "storage.failed",
  "recovery.completed",
  "retention.completed",
  "startup.completed",
  "shutdown.completed",
  "operation.failed",
] as const;
const outcomes = [
  "ok",
  "error",
  "accepted",
  "duplicate",
  "rejected",
  "retryable",
  "unknown",
  "sent",
  "busy",
  "conflict",
  "unauthorized",
  "connected",
  "disconnected",
  "degraded",
  "stale",
  "not_found",
  "not_pending",
  "claimed",
  "completed",
  "updated",
];
const errorCodes = [
  "timeout",
  "network",
  "authentication",
  "authorization",
  "rate_limit",
  "invalid_input",
  "conflict",
  "storage",
  "unsupported",
  "unavailable",
  "unknown",
  "internal",
];
const plugins = [
  ...channels.map((id) => `channel-${id}`),
  ...agents.map((id) => `agent-${id}`),
  "storage-sqlite",
  "storage-postgres",
  "observability-standard",
  "core",
  "cli",
];
const vocabulary: Record<string, readonly string[]> = {
  channel: channels,
  agent: agents,
  plugin: plugins,
  operation: operations,
  outcome: outcomes,
  error_class: errorCodes,
};
const labelNames = Object.keys(vocabulary);
export const metricDefinitions = {
  relanox_inbound_total: "counter",
  relanox_dispatch_total: "counter",
  relanox_delivery_total: "counter",
  relanox_retries_total: "counter",
  relanox_http_duration_seconds: "histogram",
  relanox_storage_duration_seconds: "histogram",
  relanox_dispatch_duration_seconds: "histogram",
  relanox_send_duration_seconds: "histogram",
  relanox_result_duration_seconds: "histogram",
  relanox_delivery_duration_seconds: "histogram",
  relanox_pending: "gauge",
  relanox_claimed: "gauge",
  relanox_outbound: "gauge",
  relanox_unknown: "gauge",
  relanox_oldest_pending_age_seconds: "gauge",
  relanox_worker_last_success_timestamp_seconds: "gauge",
  relanox_connection_status: "gauge",
  relanox_storage_stats_stale: "gauge",
} as const;
export interface StandardConfig {
  readonly logs: boolean;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly metrics: boolean;
  readonly processMetrics: boolean;
  readonly logBufferBytes: number;
  readonly lifecycleTimeoutMs: number;
  readonly tracing?: {
    readonly endpoint: string;
    readonly sampleRatio: number;
    readonly maxQueueSize: number;
    readonly maxExportBatchSize: number;
    readonly scheduledDelayMs: number;
    readonly exportTimeoutMs: number;
  };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid observability configuration");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("unknown observability configuration field");
  }
}
function number(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isInteger(result))
  ) {
    throw new Error("invalid observability numeric configuration");
  }
  return result;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError("invalid observability boolean configuration");
  }
  return value;
}
export function validateStandardConfig(input: unknown): StandardConfig {
  const raw = object(input);
  keys(raw, [
    "logs",
    "level",
    "metrics",
    "processMetrics",
    "logBufferBytes",
    "lifecycleTimeoutMs",
    "tracing",
  ]);
  const level = raw.level ?? "info";
  if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new Error("invalid log level");
  }
  let tracing: StandardConfig["tracing"];
  if (raw.tracing !== undefined) {
    const value = object(raw.tracing);
    keys(value, [
      "endpoint",
      "sampleRatio",
      "maxQueueSize",
      "maxExportBatchSize",
      "scheduledDelayMs",
      "exportTimeoutMs",
    ]);
    if (typeof value.endpoint !== "string") {
      throw new TypeError("tracing requires explicit endpoint");
    }
    const url = new URL(value.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid tracing endpoint");
    }
    const maxQueueSize = number(value.maxQueueSize, 512, 1, 4096);
    tracing = {
      endpoint: url.href,
      sampleRatio: number(value.sampleRatio, 0.1, 0, 1, false),
      maxQueueSize,
      maxExportBatchSize: number(
        value.maxExportBatchSize,
        Math.min(128, maxQueueSize),
        1,
        maxQueueSize,
      ),
      scheduledDelayMs: number(value.scheduledDelayMs, 1000, 100, 10_000),
      exportTimeoutMs: number(value.exportTimeoutMs, 2000, 100, 10_000),
    };
  }
  return {
    logs: boolean(raw.logs, true),
    level,
    metrics: boolean(raw.metrics, true),
    processMetrics: boolean(raw.processMetrics, true),
    logBufferBytes: number(raw.logBufferBytes, 65_536, 1024, 1_048_576),
    lifecycleTimeoutMs: number(raw.lifecycleTimeoutMs, 3000, 100, 10_000),
    ...(tracing ? { tracing } : {}),
  };
}
function member(value: unknown, values: readonly string[]): string | undefined {
  return typeof value === "string" && values.includes(value) ? value : undefined;
}
function safeFields(fields: LogFields = {}): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, values] of Object.entries({
    plugin: plugins,
    errorCode: [
      ...errorCodes,
      "call_timeout",
      "retry_budget_exhausted",
      "invalid_chunk_index",
      "plugin_missing",
      "plugin_exception",
      "invalid_plugin_outcome",
      "storage_unavailable",
      "not_accepting",
      "worker_failed",
    ],
    outcome: outcomes,
    operation: operations,
  })) {
    const value = member(fields[key as keyof LogFields], values);
    if (value) {
      safe[key] = value;
    }
  }
  // Correlation IDs are generated UUIDs; arbitrary caller strings cannot carry message text or secrets.
  for (const key of ["requestId", "deliveryId"] as const) {
    const value = fields[key];
    if (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    ) {
      safe[key] = value;
    }
  }
  if (typeof fields.traceId === "string" && /^[0-9a-f]{32}$/iu.test(fields.traceId)) {
    safe.traceId = fields.traceId;
  }
  return safe;
}
function safeLabels(labels: MetricLabels = {}): Record<string, string> | undefined {
  const safe: Record<string, string> = {};
  // Reject unknown keys/values entirely: mapping hostile identities into combinations still grows cardinality.
  for (const key of Object.keys(labels)) {
    if (!labelNames.includes(key)) {
      return undefined;
    }
  }
  for (const key of labelNames) {
    const value = labels[key as keyof MetricLabels];
    if (value !== undefined && !member(value, vocabulary[key] ?? [])) {
      return undefined;
    }
    safe[key] = value ?? "none";
  }
  return safe;
}

class BoundedLogWriter {
  private queue: string[] = [];
  private bytes = 0;
  private blocked = false;
  private failed = false;
  private closed = false;
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly destination: Writable,
    private readonly maxBytes: number,
    private readonly dropped: () => void,
  ) {
    destination.on("drain", this.drain);
    destination.on("error", this.error);
  }
  private readonly error = (): void => {
    this.failed = true;
    this.queue = [];
    this.bytes = 0;
    this.wake();
  };
  private readonly drain = (): void => {
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const line = this.queue.shift();
      if (line === undefined) {
        break;
      }
      this.bytes -= Buffer.byteLength(line);
      this.write(line);
    }
    if (!this.blocked && this.queue.length === 0) {
      this.wake();
    }
  };
  private wake(): void {
    for (const done of this.waiters) {
      done();
    }
  }
  write(line: string): void {
    if (this.closed || this.failed) {
      this.dropped();
      return;
    }
    if (this.blocked) {
      const size = Buffer.byteLength(line);
      if (size > this.maxBytes - this.bytes) {
        this.dropped();
        return;
      }
      this.queue.push(line);
      this.bytes += size;
      return;
    }
    try {
      this.blocked = !this.destination.write(line);
    } catch {
      this.error();
      this.dropped();
    }
  }
  async flush(signal: AbortSignal): Promise<void> {
    if (this.failed || (!this.blocked && this.queue.length === 0) || signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    this.bytes = 0;
    this.wake();
    this.destination.removeListener("drain", this.drain);
    this.destination.removeListener("error", this.error);
  }
}
/** Destination is for a production-owned collector stream; the plugin never owns/ends stdout or that stream. */
export function createStandardObservability(
  options: { readonly logDestination?: Writable } = {},
): ObservabilityPlugin<StandardConfig> {
  return {
    id: "observability-standard",
    kind: "observability",
    sdkMajor: 1,
    runtime: "node",
    validateConfig: validateStandardConfig,
    async setup(input): Promise<ObservabilityRuntime> {
      const config = validateStandardConfig(input);
      const registry = new Registry();
      const dropped = new Counter({
        name: "relanox_telemetry_dropped_total",
        help: "Dropped telemetry records",
        labelNames: ["signal"],
        registers: [registry],
      });
      const counters = new Map<string, Counter<string>>();
      const histograms = new Map<string, Histogram<string>>();
      const gauges = new Map<string, Gauge<string>>();
      for (const [name, kind] of Object.entries(metricDefinitions)) {
        const shared = {
          name,
          help: name.replaceAll("_", " "),
          labelNames,
          registers: [registry],
        };
        if (kind === "counter") {
          counters.set(name, new Counter(shared));
        }
        if (kind === "gauge") {
          gauges.set(name, new Gauge(shared));
        }
        if (kind === "histogram") {
          histograms.set(
            name,
            new Histogram({
              ...shared,
              buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 30, 120, 600, 3600],
            }),
          );
        }
      }
      if (config.metrics && config.processMetrics) {
        collectDefaultMetrics({ register: registry, prefix: "relanox_" });
      }
      const writer = new BoundedLogWriter(
        options.logDestination ?? process.stdout,
        config.logBufferBytes,
        () => {
          dropped.inc({ signal: "logs" });
        },
      );
      const logger = pino(
        {
          level: config.level,
          base: null,
          timestamp: pino.stdTimeFunctions.isoTime,
        },
        {
          write: (line) => {
            writer.write(line);
          },
        },
      );
      // Do not register a global provider/context manager: instances and other applications remain independent.
      const provider = config.tracing
        ? new NodeTracerProvider({
            resource: resourceFromAttributes({
              "service.name": "relanox",
              "service.version": "0.1.0",
            }),
            sampler: new TraceIdRatioBasedSampler(config.tracing.sampleRatio),
            spanLimits: {
              attributeCountLimit: 12,
              attributeValueLengthLimit: 128,
              eventCountLimit: 0,
              linkCountLimit: 1,
            },
            spanProcessors: [
              new BatchSpanProcessor(
                new OTLPTraceExporter({
                  url: config.tracing.endpoint,
                  headers: {},
                  timeoutMillis: config.tracing.exportTimeoutMs,
                  concurrencyLimit: 1,
                }),
                {
                  maxQueueSize: config.tracing.maxQueueSize,
                  maxExportBatchSize: config.tracing.maxExportBatchSize,
                  scheduledDelayMillis: config.tracing.scheduledDelayMs,
                  exportTimeoutMillis: config.tracing.exportTimeoutMs,
                },
              ),
            ],
          })
        : undefined;
      const tracer = provider?.getTracer("relanox-observability", "0.1.0");
      const series = new Map<string, Set<string>>();
      const labelsFor = (
        name: string,
        labels?: MetricLabels,
      ): Record<string, string> | undefined => {
        const safe = safeLabels(labels);
        if (!safe) {
          return undefined;
        }
        const key = JSON.stringify(safe);
        const tuples = series.get(name) ?? new Set<string>();
        if (!tuples.has(key) && tuples.size >= 64) {
          dropped.inc({ signal: "metrics" });
          return undefined;
        }
        tuples.add(key);
        series.set(name, tuples);
        return safe;
      };
      let closed = false;
      const isolate = (operation: () => void, signal: string): void => {
        if (closed) {
          return;
        }
        try {
          operation();
        } catch {
          dropped.inc({ signal });
        }
      };
      const observe: Observability = {
        log(level, event, fields) {
          isolate(() => {
            if (!config.logs || !member(level, ["debug", "info", "warn", "error"])) {
              return;
            }
            logger[level]({
              event: member(event, events) ?? "operation.failed",
              ...safeFields(fields),
            });
          }, "logs");
        },
        count(name, labels, value = 1) {
          isolate(() => {
            if (!config.metrics || !Number.isFinite(value) || value < 0) {
              return;
            }
            if (!counters.has(name)) {
              return;
            }
            const safe = labelsFor(name, labels);
            if (safe) {
              counters.get(name)?.inc(safe, value);
            }
          }, "metrics");
        },
        record(name, value, labels) {
          isolate(() => {
            if (!config.metrics || !Number.isFinite(value) || value < 0) {
              return;
            }
            if (!histograms.has(name) && !gauges.has(name)) {
              return;
            }
            const safe = labelsFor(name, labels);
            if (!safe) {
              return;
            }
            histograms.get(name)?.observe(safe, value);
            gauges.get(name)?.set(safe, value);
          }, "metrics");
        },
        span(name, fields, parent): Span {
          if (closed || !tracer || !member(name, operations)) {
            return { end() {} };
          }
          try {
            let context = ROOT_CONTEXT;
            if (parent && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u.test(parent.traceparent)) {
              const parts = parent.traceparent.split("-");
              const traceId = parts[1];
              const spanId = parts[2];
              if (traceId && spanId && !/^0+$/u.test(traceId) && !/^0+$/u.test(spanId)) {
                context = trace.setSpanContext(context, {
                  traceId,
                  spanId,
                  traceFlags: parts[3] === "01" ? 1 : 0,
                  isRemote: true,
                });
              }
            }
            const span = tracer.startSpan(name, { attributes: safeFields(fields) }, context);
            const spanContext = span.spanContext();
            const durable: TraceContext = {
              traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 1) === 1 ? "01" : "00"}`,
            };
            let ended = false;
            return {
              context: durable,
              end(outcome = "ok") {
                if (ended) {
                  return;
                }
                ended = true;
                isolate(() => {
                  span.setStatus({
                    code: outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                  });
                  span.end();
                }, "traces");
              },
            };
          } catch {
            dropped.inc({ signal: "traces" });
            return { end() {} };
          }
        },
      };
      async function bounded(
        signal: AbortSignal,
        operation: (boundedSignal: AbortSignal) => Promise<unknown>,
      ): Promise<void> {
        if (signal.aborted) {
          return;
        }
        const controller = new AbortController();
        const abort = () => {
          controller.abort();
        };
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, config.lifecycleTimeoutMs);
        try {
          await Promise.race([
            Promise.resolve()
              .then(() => operation(controller.signal))
              .catch(() => {
                dropped.inc({ signal: "traces" });
              }),
            new Promise<void>((resolve) => {
              controller.signal.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                {
                  once: true,
                },
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      }
      const metrics = async (request: Request): Promise<Response> => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response(null, {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        try {
          return new Response(request.method === "HEAD" ? null : await registry.metrics(), {
            headers: {
              "content-type": registry.contentType,
              "cache-control": "no-store",
            },
          });
        } catch {
          return new Response("metrics unavailable\n", { status: 503 });
        }
      };
      let shutdown: Promise<void> | undefined;
      return {
        observe,
        ...(config.metrics ? { metrics } : {}),
        async flush(signal) {
          if (closed) {
            return;
          }
          await bounded(signal, async (deadline) => {
            await Promise.all([writer.flush(deadline), provider?.forceFlush()]);
          });
        },
        shutdown(signal) {
          shutdown ??= (async () => {
            closed = true;
            // Start shutdown even for an already-aborted caller, so provider timers are always released.
            const stopped = provider?.shutdown().catch(() => {
              dropped.inc({ signal: "traces" });
            });
            await bounded(signal, async (deadline) => {
              await Promise.all([writer.flush(deadline), stopped]);
            });
            writer.close();
            registry.clear();
          })();
          return shutdown;
        },
      };
    },
  };
}
