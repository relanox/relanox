import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "@prometheus-io/client";
import type { MetricLabels, Observability } from "@relanox/sdk";
import type { StandardConfig } from "./config.js";
import { labelNames, metricDefinitions, safeLabels } from "./fields.js";

export interface MetricsRuntime extends Pick<Observability, "count" | "record"> {
  readonly registry: Registry;
  readonly dropped: Counter<string>;
  metrics(this: void, request: Request): Promise<Response>;
}

export function createMetrics(config: StandardConfig): MetricsRuntime {
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
  const series = new Map<string, Set<string>>();

  const labelsFor = (name: string, labels?: MetricLabels): Record<string, string> | undefined => {
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

  const observe: Pick<Observability, "count" | "record"> = {
    count(name, labels, value = 1) {
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
    },
    record(name, value, labels) {
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
    },
  };

  return { ...observe, metrics, registry, dropped };
}
