import { createServer } from "node:http";
import type { Server } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { noopObservability } from "@relanox/sdk";
import type { LogFields, MetricLabels, ObservabilityRuntime } from "@relanox/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createStandardObservability, validateStandardConfig } from "../src/index.js";

const runtimes: ObservabilityRuntime[] = [];
const servers: Server[] = [];
const signal = () => AbortSignal.timeout(3000);
async function runtime(config: Record<string, unknown> = {}, destination?: Writable) {
  const plugin = createStandardObservability(destination ? { logDestination: destination } : {});
  const result = await plugin.setup(
    plugin.validateConfig({ logs: false, processMetrics: false, ...config }),
  );
  runtimes.push(result);
  return result;
}
async function metrics(value: ObservabilityRuntime): Promise<string> {
  if (!value.metrics) {
    throw new Error("missing metrics handler");
  }
  const response = await value.metrics(new Request("http://localhost/metrics"));
  expect(response.status).toBe(200);
  return response.text();
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((value) => value.shutdown(signal())));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
});

describe("jSON log boundary", () => {
  it.each([
    ["channel_policy_rejection", "sender_not_allowed", "inbound.rejected", "authorization"],
    ["channel_input_discarded", "unbound_conversation", "inbound.rejected", "authorization"],
    ["channel_unsupported_input", "unsupported_message_type", "inbound.rejected", "unsupported"],
    ["channel_unsupported_sender", "missing_staff_id", "inbound.rejected", "invalid_input"],
    ["channel_event_ignored", "unsupported_or_self_text", "inbound.rejected", "unsupported"],
    ["channel_invalid_frame", "invalid_frame", "inbound.rejected", "invalid_input"],
    ["channel_connection_replaced", "bot_connection_replaced", "connection.changed", "conflict"],
    ["operation.failed", "encrypted_unsupported", "operation.failed", "unsupported"],
    ["operation.failed", "authentication_timeout", "operation.failed", "timeout"],
    ["operation.failed", "connection_failed", "operation.failed", "network"],
  ])("normalizes native %s / %s diagnostics", async (event, code, expectedEvent, expectedCode) => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const value = await runtime({ logs: true }, output);
    value.observe.log("warn", event, { operation: "receive", errorCode: code });
    value.observe.log("warn", "channel_SECRET", {
      operation: "receive_SECRET",
      errorCode: "unsupported_SECRET",
    });
    await value.flush(signal());
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      event: expectedEvent,
      operation: "ingest",
      errorCode: expectedCode,
    });
    expect(lines[1]).toMatchObject({ event: "operation.failed" });
    expect(lines[1]).not.toHaveProperty("operation");
    expect(lines[1]).not.toHaveProperty("errorCode");
    expect(text).not.toContain("SECRET");
  });

  it.each(["flush", "shutdown"] as const)(
    "%s waits for accepted asynchronous collector writes below the high-water mark",
    async (operation) => {
      let release: (() => void) | undefined;
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          release = callback;
        },
      });
      const value = await runtime({ logs: true }, output);
      value.observe.log("info", "shutdown.completed", { plugin: "core" });
      let finished = false;
      const completion = value[operation](signal()).then(() => {
        finished = true;
        return finished;
      });
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(finished).toBe(false);
      } finally {
        release?.();
        await completion;
      }
      expect(finished).toBe(true);
      expect(output.writableFinished).toBe(false);
      output.end();
    },
  );

  it("keeps safe correlation fields and excludes arbitrary payloads and error strings", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const value = await runtime({ logs: true }, output);
    value.observe.log("info", "inbound.accepted", {
      requestId: "11223344-1122-4433-8899-112233445566",
      plugin: "core",
      text: "PRIVATE MESSAGE",
      authorization: "Bearer TOKEN",
      error: new Error("https://api.telegram.org/botSECRET"),
      errorCode: "botSECRET",
      outcome: "accepted",
    } as LogFields);
    value.observe.log("error", "PRIVATE EVENT", {
      operation: "PRIVATE OPERATION",
      requestId: "PRIVATE ID",
      traceId: "TOKEN",
      errorCode: "call_timeout",
    });
    await value.flush(signal());
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: 30,
      event: "inbound.accepted",
      requestId: "11223344-1122-4433-8899-112233445566",
      plugin: "core",
      outcome: "accepted",
    });
    expect(Object.keys(lines[0] ?? {}).toSorted()).toEqual([
      "event",
      "level",
      "outcome",
      "plugin",
      "requestId",
      "time",
    ]);
    expect(lines[1]).toMatchObject({
      event: "operation.failed",
      errorCode: "call_timeout",
    });
    expect(text).not.toMatch(/PRIVATE|TOKEN|SECRET|authorization|hostname/u);
  });

  it("bounds backpressured logging and absorbs collector failure", async () => {
    let release: (() => void) | undefined;
    let writes = 0;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        writes++;
        release = () => {
          callback();
        };
      },
    });
    output.on("error", () => {});
    const value = await runtime({ logs: true, logBufferBytes: 1024 }, output);
    for (let index = 0; index < 1000; index++) {
      value.observe.log("info", "inbound.accepted", { plugin: "core" });
    }
    expect(writes).toBe(1);
    expect(await metrics(value)).toMatch(/relanox_telemetry_dropped_total\{signal="logs"\} 9\d\d/u);
    output.destroy(new Error("collector failed"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(() => {
      value.observe.log("error", "operation.failed");
    }).not.toThrow();
    await value.flush(signal());
    release?.();
  });
});

describe("prometheus public facade", () => {
  it("counts observations, replaces gauges, records seconds and isolates registries", async () => {
    const first = await runtime();
    const second = await runtime();
    first.observe.count("relanox_inbound_total", { channel: "telegram", outcome: "accepted" }, 2);
    first.observe.count("relanox_inbound_total", {
      channel: "telegram",
      outcome: "accepted",
    });
    first.observe.record("relanox_pending", 9);
    first.observe.record("relanox_pending", 2);
    first.observe.record("relanox_send_duration_seconds", 0.25, {
      channel: "telegram",
    });
    const body = await metrics(first);
    expect(body).toMatch(
      /relanox_inbound_total\{[^\n]*channel="telegram"[^\n]*outcome="accepted"[^\n]*\} 3/u,
    );
    expect(body).toMatch(/# TYPE relanox_pending gauge/u);
    expect(body).toMatch(/relanox_pending\{[^\n]*\} 2/u);
    expect(body).toMatch(/relanox_send_duration_seconds_sum\{[^\n]*\} 0.25/u);
    expect(body).toMatch(/relanox_send_duration_seconds_bucket\{le="0.5"[^\n]*\} 1/u);
    expect(await metrics(second)).not.toMatch(/channel="telegram"/u);
    const response = await first.metrics?.(
      new Request("http://localhost/metrics", { method: "POST" }),
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD");
    const head = await first.metrics?.(new Request("http://localhost/metrics", { method: "HEAD" }));
    expect(head?.headers.get("content-type")).toContain("text/plain");
    expect(await head?.text()).toBe("");
  });

  it("rejects identity labels, unknown names, invalid numbers and caps finite combinations", async () => {
    const value = await runtime();
    value.observe.count("secret_metric", {}, 1);
    value.observe.count("relanox_inbound_total", { channel: "secret-user" });
    value.observe.count("relanox_inbound_total", {
      requestId: "private",
    } as MetricLabels);
    value.observe.count("relanox_inbound_total", {}, -1);
    value.observe.record("relanox_pending", Number.NaN);
    value.observe.record("relanox_inbound_total", 99);
    let accepted = 0;
    for (const channel of [
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
    ]) {
      for (const outcome of ["accepted", "duplicate", "rejected", "error", "unknown"]) {
        value.observe.count("relanox_inbound_total", { channel, outcome });
        accepted++;
      }
    }
    expect(accepted).toBe(75);
    const body = await metrics(value);
    expect(body).not.toMatch(/secret_metric|secret-user|requestId|private| 99/u);
    expect(
      body.split("\n").filter((line) => line.startsWith("relanox_inbound_total{")),
    ).toHaveLength(64);
    expect(body).toContain('relanox_telemetry_dropped_total{signal="metrics"} 11');
  });

  it("disabled signals and SDK noop perform no external work", async () => {
    const output = new PassThrough();
    let bytes = 0;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    const value = await runtime({ logs: false, metrics: false }, output);
    value.observe.log("info", "inbound.accepted");
    value.observe.count("relanox_inbound_total");
    const span = value.observe.span("ingest");
    expect(span.context).toBeUndefined();
    span.end();
    expect(value.metrics).toBeUndefined();
    expect(bytes).toBe(0);
    expect(() => {
      noopObservability.log("error", "operation.failed");
      noopObservability.count("arbitrary");
      noopObservability.record("arbitrary", 0);
      noopObservability.span("ingest").end();
    }).not.toThrow();
    await value.shutdown(signal());
    expect(() => {
      value.observe.log("info", "inbound.accepted");
    }).not.toThrow();
  });

  it.each([
    { tracing: {} },
    { tracing: { endpoint: "file:///secret" } },
    { tracing: { endpoint: "http://user:pass@localhost/traces" } },
    { tracing: { endpoint: "http://localhost/traces?token=secret" } },
    { tracing: { endpoint: "http://localhost/traces", sampleRatio: 2 } },
    {
      tracing: {
        endpoint: "http://localhost/traces",
        maxQueueSize: 2,
        maxExportBatchSize: 3,
      },
    },
    { arbitrary: true },
    { logs: "yes" },
    { logBufferBytes: 0 },
  ])("rejects unsafe configuration %j", (config) => {
    expect(() => validateStandardConfig(config)).toThrow();
  });
});

async function collector(status = 200) {
  const requests: {
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({ headers: request.headers, body });
      if (status === 0) {
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing server port");
  }
  return { endpoint: `http://127.0.0.1:${address.port}/v1/traces`, requests };
}
function wireSpans(requests: { body: string }[]): Record<string, unknown>[] {
  return requests.flatMap((request) => {
    const body = JSON.parse(request.body) as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    return body.resourceSpans.flatMap(
      (resource: { scopeSpans: { spans: Record<string, unknown>[] }[] }) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
    );
  });
}
describe("real OTLP HTTP transport", () => {
  it("exports one safe short span and serialized durable parent, independently per runtime", async () => {
    const first = await collector();
    const second = await collector();
    const left = await runtime({
      tracing: { endpoint: first.endpoint, sampleRatio: 1 },
    });
    const right = await runtime({
      tracing: { endpoint: second.endpoint, sampleRatio: 1 },
    });
    const root = left.observe.span("ingest", {
      requestId: "11223344-1122-4433-8899-112233445566",
      text: "PRIVATE",
    } as LogFields);
    expect(root.context?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
    const child = left.observe.span(
      "send",
      { errorCode: "SECRET" },
      JSON.parse(JSON.stringify(root.context)) as typeof root.context,
    );
    root.end();
    root.end("error");
    child.end("error");
    right.observe.span("dispatch").end();
    await left.flush(signal());
    await right.shutdown(signal());
    const spans = wireSpans(first.requests);
    expect(spans).toHaveLength(2);
    const ingest = spans.find((span) => span.name === "ingest");
    const send = spans.find((span) => span.name === "send");
    expect(send?.traceId).toBe(ingest?.traceId);
    expect(send?.parentSpanId).toBe(ingest?.spanId);
    expect(ingest?.status).toEqual({ code: 1 });
    expect(send?.status).toEqual({ code: 2 });
    expect(wireSpans(second.requests)).toMatchObject([{ name: "dispatch" }]);
    expect(JSON.stringify(first.requests)).not.toMatch(/PRIVATE|SECRET|hostname|tracestate/u);
    expect(first.requests[0]?.headers["content-type"]).toContain("application/json");
  });

  it("collector errors do not reject business or lifecycle calls", async () => {
    const peer = await collector(400);
    const value = await runtime({
      tracing: {
        endpoint: peer.endpoint,
        sampleRatio: 1,
        exportTimeoutMs: 100,
      },
      lifecycleTimeoutMs: 100,
    });
    expect(() => {
      value.observe.span("send").end("error");
      value.observe.count("relanox_delivery_total", { outcome: "unknown" });
    }).not.toThrow();
    await expect(value.flush(signal())).resolves.toBeUndefined();
    await expect(value.shutdown(signal())).resolves.toBeUndefined();
    expect(peer.requests.length).toBeGreaterThan(0);
  });

  it("bounds lifecycle when a collector accepts HTTP but never responds", async () => {
    const peer = await collector(0);
    const value = await runtime({
      tracing: {
        endpoint: peer.endpoint,
        sampleRatio: 1,
        exportTimeoutMs: 1000,
      },
      lifecycleTimeoutMs: 100,
    });
    value.observe.span("send").end();
    const result = await Promise.race([
      value.flush(signal()).then(() => "finished"),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("hung");
        }, 1000);
      }),
    ]);
    expect(result).toBe("finished");
    expect(peer.requests).toHaveLength(1);
    const alreadyAborted = AbortSignal.abort();
    await expect(value.shutdown(alreadyAborted)).resolves.toBeUndefined();
  });

  it("ratio-zero sampling preserves context without exporting message metadata", async () => {
    const peer = await collector();
    const value = await runtime({
      tracing: { endpoint: peer.endpoint, sampleRatio: 0 },
    });
    const span = value.observe.span("ingest");
    expect(span.context?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/u);
    span.end();
    await value.flush(signal());
    expect(peer.requests).toHaveLength(0);
  });
});
