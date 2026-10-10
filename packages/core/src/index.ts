import type {
  AgentHost,
  AgentId,
  AgentPlugin,
  AgentPrincipal,
  ChannelHost,
  ChannelPlugin,
  CommonHost,
  DispatchResult,
  DueWork,
  Health,
  IngestInput,
  Json,
  MutationResult,
  Observability,
  RelanoxConfig,
  ScopedAgentHost,
  SendResult,
  StateNamespace,
  StatusFilter,
  Storage,
  TraceContext,
} from "@relanox/sdk";
import { Hono } from "hono";
import { z } from "zod";
import { chunkText } from "./chunk.js";
import {
  bindingKey,
  jsonSnapshot,
  validateConfig,
  validateJson,
} from "./config.js";
import { safeObservability } from "./observe.js";

export * from "./chunk.js";
export * from "./config.js";
export * from "./observe.js";

export class CoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CoreError";
  }
}
export interface WorkerOptions {
  readonly batchSize?: number;
  readonly batchDurationMs?: number;
  readonly callTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly notificationIntervalMs?: number;
  readonly maxTextBytes?: number;
  readonly maxContextBytes?: number;
  readonly maxHttpBodyBytes?: number;
}
export interface CoreOptions {
  readonly config: unknown;
  readonly storage: Storage;
  readonly channels: ReadonlyMap<string, ChannelPlugin<unknown>>;
  readonly agents: ReadonlyMap<AgentId, AgentPlugin<unknown>>;
  readonly observe?: Observability;
  readonly worker?: WorkerOptions;
}
const workerSchema = z
  .strictObject({
    batchSize: z.number().int().min(1).max(1000).default(32),
    batchDurationMs: z.number().int().min(1).max(300000).default(30000),
    callTimeoutMs: z.number().int().min(1).max(120000).default(10000),
    leaseMs: z.number().int().min(1).max(300000).default(30000),
    maxAttempts: z.number().int().min(1).max(100).default(8),
    retryBaseMs: z.number().int().min(1).max(300000).default(1000),
    retryMaxMs: z.number().int().min(1).max(3600000).default(300000),
    notificationIntervalMs: z.number().int().min(1).max(3600000).default(60000),
    maxTextBytes: z.number().int().min(1).max(16777216).default(1048576),
    maxContextBytes: z.number().int().min(1).max(1048576).default(65536),
    maxHttpBodyBytes: z.number().int().min(1).max(16777216).default(2097152),
  })
  .superRefine((v, ctx) => {
    if (v.leaseMs <= v.callTimeoutMs || v.retryMaxMs < v.retryBaseMs)
      ctx.addIssue({
        code: "custom",
        message:
          "Lease must exceed call timeout; retry maximum must exceed base",
      });
  });
const textId = z.string().min(1).max(1024);
const ingestSchema = z.strictObject({
  source: z.strictObject({
    channel: textId,
    accountId: textId,
    eventId: textId,
  }),
  senderId: textId,
  text: z.string().min(1),
  target: z.strictObject({
    channel: textId,
    accountId: textId,
    chatId: textId,
    threadId: textId.optional(),
    replyToId: textId.optional(),
    data: z.json(),
  }),
  receivedAt: z.number().int().nonnegative().safe(),
  context: z.json(),
  trace: z
    .strictObject({
      traceparent: z
        .string()
        .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
      tracestate: z.string().max(512).optional(),
    })
    .optional(),
});
export interface CoreRuntime {
  readonly config: RelanoxConfig;
  fetch(request: Request): Promise<Response>;
  processDue(): Promise<{
    readonly processed: number;
    readonly conflicts: number;
  }>;
  status(filter?: StatusFilter): Promise<{
    readonly stats: Awaited<ReturnType<Storage["getStats"]>>;
    readonly connections: Readonly<Record<string, string>>;
    readonly requests: Awaited<ReturnType<Storage["listInbound"]>>;
    readonly deliveries: Awaited<ReturnType<Storage["listOutbound"]>>;
  }>;
  health(): Promise<Health>;
  readiness(): Promise<Health>;
  cleanup(input: {
    readonly before: number;
    readonly limit: number;
  }): ReturnType<Storage["cleanup"]>;
  requeue(input: {
    readonly kind: "request" | "delivery";
    readonly id: string;
    readonly expectedVersion: number;
    readonly acknowledgeUnknown: boolean;
  }): Promise<MutationResult>;
  setAccepting(accepting: boolean): void;
}
/** Creates scoped plugin hosts and registers routes; listener/timers/plugin lifecycle belong to CLI. */
export async function createCore(options: CoreOptions): Promise<CoreRuntime> {
  const config = validateConfig(options.config);
  const storage = options.storage;
  const observe = safeObservability(options.observe);
  const worker = workerSchema.parse(options.worker ?? {});
  const app = new Hono();
  const endpoints = new Map(config.endpoints.map((e) => [e.id, e]));
  const bindings = new Map(
    config.bindings.map((b) => [
      bindingKey(b.accountId, b.chatId, b.threadId),
      b,
    ]),
  );
  const connections = new Map<
    string,
    "connected" | "disconnected" | "degraded"
  >();
  const routes = new Set<string>();
  const componentPlugins = new Map<string, string>();
  let accepting = true;
  let busy = false;
  let workerError = false;
  const owner = crypto.randomUUID();
  async function traced<T>(
    operation: "ingest" | "claim" | "complete" | "fail" | "storage",
    action: (context?: TraceContext) => Promise<T>,
    parent?: IngestInput["trace"],
  ): Promise<T> {
    const span = observe.span(operation, { plugin: "core", operation }, parent);
    const start = Date.now();
    try {
      const result = await action(span.context ?? parent);
      span.end("ok");
      return result;
    } catch (error) {
      span.end("error");
      throw error;
    } finally {
      observe.record(
        "relanox_storage_duration_seconds",
        (Date.now() - start) / 1000,
        { operation },
      );
    }
  }
  async function refreshStats(): Promise<void> {
    try {
      const stats = await storage.getStats();
      observe.record("relanox_pending", stats.pending);
      observe.record("relanox_claimed", stats.claimed);
      observe.record("relanox_outbound", stats.undelivered);
      observe.record("relanox_unknown", stats.unknown);
      observe.record(
        "relanox_oldest_pending_age_seconds",
        stats.oldestPendingAt === undefined
          ? 0
          : Math.max(0, (Date.now() - stats.oldestPendingAt) / 1000),
      );
      observe.record("relanox_storage_stats_stale", 0);
    } catch {
      observe.record("relanox_storage_stats_stale", 1);
    }
  }
  const accountValidated = new Map<string, unknown>();
  // Validate every endpoint before setup can register a live route. Keep ORIGINAL JSON in snapshots.
  for (const account of config.accounts) {
    const plugin = options.channels.get(account.id);
    if (
      !plugin ||
      plugin.channel !== account.channel ||
      plugin.sdkMajor !== 1 ||
      plugin.runtime !== "node"
    )
      throw new CoreError("channel_plugin_mismatch");
    chunkText(
      "",
      plugin.capabilities.maxTextLength,
      plugin.capabilities.lengthUnit,
    );
    accountValidated.set(
      account.id,
      plugin.validateConfig(jsonSnapshot(account.config)),
    );
    if (plugin.capabilities.transport !== "http")
      connections.set(`channels/${account.id}`, "disconnected");
  }
  for (const endpoint of config.endpoints) {
    const plugin = options.agents.get(endpoint.agent);
    if (
      !plugin ||
      plugin.agent !== endpoint.agent ||
      plugin.sdkMajor !== 1 ||
      plugin.runtime !== "node"
    )
      throw new CoreError("agent_plugin_mismatch");
    plugin.validateConfig(jsonSnapshot(endpoint.config));
  }
  function boundedText(text: string, nonempty = true): void {
    if (
      typeof text !== "string" ||
      (nonempty && !text.length) ||
      !text.isWellFormed() ||
      new TextEncoder().encode(text).length > worker.maxTextBytes
    )
      throw new CoreError("invalid_text");
  }
  function common(namespace: StateNamespace, prefix: string): CommonHost {
    componentPlugins.set(prefix.slice(1), namespace.pluginId);
    return {
      observe,
      state: {
        get: (key) => storage.getState(namespace, textId.parse(key)),
        list: (input) =>
          storage.listState(namespace, { ...input, limit: limit(input.limit) }),
        compareAndSet: (input) =>
          storage.compareAndSetState(namespace, {
            ...input,
            key: textId.parse(input.key),
            value: validateJson(input.value),
          }),
        delete: (key, version) =>
          storage.deleteState(
            namespace,
            textId.parse(key),
            z.number().int().positive().parse(version),
          ),
      },
      mountHttp(path, handler) {
        if (
          !path.startsWith("/") ||
          /[?#\\]|\.\.|\/\//.test(path) ||
          !/^\/[A-Za-z0-9/_-]*\*?$/.test(path)
        )
          throw new CoreError("invalid_route_path");
        const route = prefix + (path === "/" ? "" : path);
        if (routes.has(route)) throw new CoreError("duplicate_route");
        routes.add(route);
        app.all(route, async (context) => {
          if (!accepting) return context.json({ error: "not_accepting" }, 503);
          return handler(context.req.raw);
        });
      },
      connection(status) {
        connections.set(prefix.slice(1), status);
        const allConnected = [...connections]
          .filter(
            ([component]) =>
              componentPlugins.get(component) === namespace.pluginId,
          )
          .every(([, componentStatus]) => componentStatus === "connected");
        observe.record("relanox_connection_status", allConnected ? 1 : 0, {
          plugin: namespace.pluginId,
        });
      },
    };
  }
  for (const account of config.accounts) {
    const plugin = options.channels.get(account.id);
    if (!plugin) throw new CoreError("channel_plugin_mismatch");
    const host: ChannelHost = {
      ...common(
        { pluginId: plugin.id, ownerId: account.id },
        `/channels/${account.id}`,
      ),
      async ingest(input: IngestInput) {
        if (!accepting) throw new CoreError("not_accepting");
        ingestSchema.parse(input);
        boundedText(input.text);
        if (
          input.source.accountId !== account.id ||
          input.target.accountId !== account.id ||
          input.source.channel !== account.channel ||
          input.target.channel !== account.channel
        )
          throw new CoreError("account_scope_mismatch");
        if (
          new TextEncoder().encode(
            JSON.stringify([input.context, input.target.data]),
          ).length > worker.maxContextBytes
        )
          throw new CoreError("context_too_large");
        const binding = bindings.get(
          bindingKey(account.id, input.target.chatId, input.target.threadId),
        );
        if (!binding) throw new CoreError("unbound_conversation");
        if (
          !account.allowedSenders.includes(input.senderId) ||
          (binding.allowedSenders &&
            !binding.allowedSenders.includes(input.senderId))
        )
          throw new CoreError("sender_not_allowed");
        const endpoint = endpoints.get(binding.endpointId);
        if (!endpoint) throw new CoreError("unbound_endpoint");
        const receipt = await traced(
          "ingest",
          (trace) =>
            storage.acceptInbound(
              jsonSnapshot({
                ...input,
                ...(trace ? { trace } : {}),
                requestId: crypto.randomUUID(),
                endpoint,
                acceptedAt: Date.now(),
              }),
            ),
          input.trace,
        );
        observe.count("relanox_inbound_total", {
          channel: account.channel,
          outcome: receipt.duplicate ? "duplicate" : "accepted",
        });
        observe.log(
          "info",
          receipt.duplicate ? "inbound.duplicate" : "inbound.accepted",
          {
            plugin: "core",
            requestId: receipt.requestId,
            outcome: receipt.duplicate ? "duplicate" : "accepted",
          },
        );
        return receipt;
      },
    };
    await plugin.setup(
      host,
      jsonSnapshot(account),
      accountValidated.get(account.id),
    );
  }
  for (const agent of new Set(config.endpoints.map((e) => e.agent))) {
    const plugin = options.agents.get(agent);
    if (!plugin) throw new CoreError("agent_plugin_mismatch");
    const agentEndpoints = config.endpoints.filter((e) => e.agent === agent);
    const host: AgentHost = {
      ...common({ pluginId: plugin.id, ownerId: agent }, `/agents/${agent}`),
      forPrincipal(principal: AgentPrincipal): ScopedAgentHost {
        textId.parse(principal.subject);
        const scope = [...new Set(principal.endpointIds)].filter((id) =>
          agentEndpoints.some((e) => e.id === id),
        );
        return {
          listPending: (count) =>
            storage.listPending({ endpointIds: scope, limit: limit(count) }),
          claim: (requestId, claimKey) =>
            traced("claim", () =>
              storage.claimRequest({
                requestId: textId.parse(requestId),
                endpointIds: scope,
                claimKey: textId.parse(claimKey),
                claimToken: crypto.randomUUID(),
                now: Date.now(),
              }),
            ),
          async complete(input) {
            textId.parse(input.requestId);
            textId.parse(input.claimToken);
            textId.parse(input.resultId);
            boundedText(input.text);
            const request = await storage.getInbound(input.requestId);
            if (!request || !scope.includes(request.snapshot.endpoint.id))
              return { status: "not_found" };
            const plugin = options.channels.get(
              request.snapshot.target.accountId,
            );
            if (!plugin) throw new CoreError("channel_plugin_missing");
            const deliveryId = crypto.randomUUID();
            const now = Date.now();
            const chunks = chunkText(
              input.text,
              plugin.capabilities.maxTextLength,
              plugin.capabilities.lengthUnit,
            ).map((text, index) => ({
              text,
              idempotencyKey: `${deliveryId}:${index}`,
              state: null as Json,
            }));
            const result = await traced(
              "complete",
              () =>
                storage.completeAndEnqueue({
                  requestId: input.requestId,
                  endpointIds: scope,
                  claimToken: input.claimToken,
                  result: {
                    resultId: input.resultId,
                    text: input.text,
                    completedAt: now,
                  },
                  outbound: {
                    deliveryId,
                    requestId: input.requestId,
                    resultId: input.resultId,
                    target: jsonSnapshot(request.snapshot.target),
                    chunks,
                    currentChunk: 0,
                    receipts: [],
                    status: "pending",
                    version: 1,
                    attempts: 0,
                    dueAt: now,
                    createdAt: now,
                    ...(request.snapshot.trace
                      ? { trace: request.snapshot.trace }
                      : {}),
                  },
                }),
              request.snapshot.trace,
            );
            if (result.status === "completed" && !result.replay)
              observe.record(
                "relanox_result_duration_seconds",
                Math.max(0, (now - request.snapshot.acceptedAt) / 1000),
                { agent },
              );
            observe.log("info", "complete.completed", {
              plugin: "core",
              requestId: input.requestId,
              outcome: result.status === "completed" ? "ok" : result.status,
            });
            return result;
          },
          fail: (input) =>
            traced("fail", () =>
              storage.fail({
                requestId: textId.parse(input.requestId),
                endpointIds: scope,
                claimToken: textId.parse(input.claimToken),
                errorCode: z
                  .string()
                  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
                  .parse(input.errorCode),
                now: Date.now(),
              }),
            ),
        };
      },
    };
    await plugin.setup(host, jsonSnapshot(agentEndpoints), {});
  }
  app.onError(
    () =>
      new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );
  const safeRetryAccountIds = config.accounts
    .filter((a) => options.channels.get(a.id)?.capabilities.idempotentSend)
    .map((a) => a.id);
  async function invoke(work: DueWork): Promise<DispatchResult | SendResult> {
    const controller = new AbortController();
    const operationName = work.kind === "dispatch" ? "dispatch" : "send";
    const span = observe.span(
      operationName,
      { plugin: "core", operation: operationName },
      work.kind === "dispatch" ? work.record.snapshot.trace : work.record.trace,
    );
    const startedAt = Date.now();
    let successful = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<DispatchResult | SendResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "unknown", errorCode: "call_timeout" });
        }, worker.callTimeoutMs);
      });
      const chunk =
        work.kind === "send"
          ? work.record.chunks[work.record.currentChunk]
          : undefined;
      if (work.kind === "send" && !chunk)
        return { status: "rejected", errorCode: "invalid_chunk_index" };
      const operation =
        work.kind === "dispatch"
          ? options.agents.get(work.record.snapshot.endpoint.agent)?.dispatch({
              request: jsonSnapshot(work.record.snapshot),
              signal: controller.signal,
            })
          : chunk
            ? options.channels.get(work.record.target.accountId)?.send({
                deliveryId: work.record.deliveryId,
                requestId: work.record.requestId,
                target: jsonSnapshot(work.record.target),
                chunk: jsonSnapshot(chunk),
                chunkIndex: work.record.currentChunk,
                signal: controller.signal,
              })
            : undefined;
      if (!operation)
        return { status: "rejected", errorCode: "plugin_missing" };
      const result = await Promise.race([operation, timeout]);
      const valid = validateOutcome(result, work.kind);
      successful = valid.status === "sent" || valid.status === "accepted";
      return valid;
    } catch {
      return { status: "unknown", errorCode: "plugin_exception" };
    } finally {
      if (timer) clearTimeout(timer);
      span.end(successful ? "ok" : "error");
      observe.record(
        work.kind === "dispatch"
          ? "relanox_dispatch_duration_seconds"
          : "relanox_send_duration_seconds",
        (Date.now() - startedAt) / 1000,
        { operation: operationName },
      );
    }
  }
  async function health(): Promise<Health> {
    try {
      return await storage.health();
    } catch {
      return { ok: false, errorCode: "storage_unavailable" };
    }
  }
  return {
    config: jsonSnapshot(config),
    async fetch(request) {
      const start = Date.now();
      try {
        return await app.fetch(
          await boundedRequest(
            request,
            worker.maxHttpBodyBytes,
            worker.callTimeoutMs,
          ),
        );
      } catch (error) {
        const code =
          error instanceof CoreError ? error.code : "invalid_request";
        return new Response(JSON.stringify({ error: code }), {
          status:
            code === "body_too_large"
              ? 413
              : code === "request_timeout"
                ? 408
                : 400,
          headers: { "content-type": "application/json" },
        });
      } finally {
        observe.record(
          "relanox_http_duration_seconds",
          (Date.now() - start) / 1000,
          { operation: "http" },
        );
      }
    },
    async processDue() {
      if (busy) return { processed: 0, conflicts: 0 };
      busy = true;
      const start = Date.now();
      let processed = 0;
      let conflicts = 0;
      try {
        while (
          processed < worker.batchSize &&
          Date.now() - start < worker.batchDurationMs
        ) {
          // Lease one at a time, so queued calls cannot expire behind earlier slow calls.
          const work = (
            await storage.takeDue({
              now: Date.now(),
              leaseMs: worker.leaseMs,
              limit: 1,
              leaseOwner: owner,
              safeRetryAccountIds,
            })
          )[0];
          if (!work) break;
          const attempts =
            work.kind === "dispatch"
              ? work.record.dispatch.attempts
              : work.record.attempts;
          let outcome: DispatchResult | SendResult =
            attempts >= worker.maxAttempts
              ? { status: "rejected", errorCode: "retry_budget_exhausted" }
              : await invoke(work);
          if (
            (outcome.status === "retryable" || outcome.status === "accepted") &&
            attempts + 1 >= worker.maxAttempts
          )
            outcome = {
              status: "rejected",
              errorCode: "retry_budget_exhausted",
            };
          const now = Date.now();
          const delay =
            outcome.status === "accepted"
              ? worker.notificationIntervalMs
              : outcome.status === "retryable"
                ? Math.max(
                    worker.retryBaseMs,
                    Math.min(
                      worker.retryMaxMs,
                      Number.isFinite(outcome.retryAfterMs) &&
                        (outcome.retryAfterMs ?? 0) >= 0
                        ? (outcome.retryAfterMs ?? 0)
                        : worker.retryBaseMs * 2 ** attempts,
                    ),
                  )
                : 0;
          const settlement =
            work.kind === "dispatch"
              ? await storage.settleAttempt({
                  kind: "dispatch",
                  id: work.record.snapshot.requestId,
                  lease: work.lease,
                  outcome: outcome as DispatchResult,
                  nextDueAt: now + delay,
                  now,
                })
              : await storage.settleAttempt({
                  kind: "send",
                  id: work.record.deliveryId,
                  lease: work.lease,
                  outcome: outcome as SendResult,
                  nextDueAt: now + delay,
                  now,
                });
          if (settlement.status !== "updated") conflicts++;
          processed++;
          if (work.kind === "dispatch")
            observe.count("relanox_dispatch_total", {
              agent: work.record.snapshot.endpoint.agent,
              outcome: outcome.status,
            });
          else
            observe.count("relanox_delivery_total", {
              channel: work.record.target.channel,
              outcome: outcome.status,
            });
          if (outcome.status === "retryable")
            observe.count("relanox_retries_total", { operation: work.kind });
          observe.log(
            outcome.status === "unknown" || outcome.status === "rejected"
              ? "warn"
              : "info",
            work.kind === "dispatch"
              ? "dispatch.completed"
              : "delivery.completed",
            {
              plugin: "core",
              operation: work.kind === "dispatch" ? "dispatch" : "send",
              requestId:
                work.kind === "dispatch"
                  ? work.record.snapshot.requestId
                  : work.record.requestId,
              ...(work.kind === "send"
                ? { deliveryId: work.record.deliveryId }
                : {}),
              outcome: outcome.status,
              ...("errorCode" in outcome
                ? { errorCode: outcome.errorCode }
                : {}),
            },
          );
        }
        workerError = false;
        observe.record(
          "relanox_worker_last_success_timestamp_seconds",
          Date.now() / 1000,
        );
        await refreshStats();
        return { processed, conflicts };
      } catch (error) {
        workerError = true;
        throw error;
      } finally {
        busy = false;
      }
    },
    async status(filter = { limit: 100 }) {
      const bounded = { ...filter, limit: limit(filter.limit) };
      const [stats, requests, deliveries] = await Promise.all([
        storage.getStats(),
        storage.listInbound(bounded),
        storage.listOutbound(bounded),
      ]);
      return {
        stats,
        connections: Object.fromEntries(connections),
        requests,
        deliveries,
      };
    },
    health,
    async readiness() {
      const status = await health();
      if (!status.ok) return status;
      if (!accepting) return { ok: false, errorCode: "not_accepting" };
      if (workerError) return { ok: false, errorCode: "worker_failed" };
      return { ok: true };
    },
    cleanup: (input) =>
      storage.cleanup({
        before: z
          .number()
          .int()
          .nonnegative()
          .safe()
          .max(Date.now())
          .parse(input.before),
        limit: limit(input.limit),
      }),
    requeue: (input) =>
      storage.requeue({
        ...input,
        id: textId.parse(input.id),
        expectedVersion: z
          .number()
          .int()
          .positive()
          .parse(input.expectedVersion),
        now: Date.now(),
      }),
    setAccepting(value) {
      accepting = value;
    },
  };
}
function limit(value: number): number {
  return z.number().int().min(1).max(1000).parse(value);
}
const errorOutcome = z.strictObject({
  status: z.enum(["rejected", "unknown"]),
  errorCode: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
});
const retryOutcome = z.strictObject({
  status: z.literal("retryable"),
  errorCode: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  retryAfterMs: z.number().finite().nonnegative().optional(),
});
const dispatchOutcome = z.union([
  z.strictObject({ status: z.literal("accepted") }),
  retryOutcome,
  errorOutcome,
]);
const sendOutcome = z.union([
  z.strictObject({
    status: z.literal("sent"),
    receipt: z.strictObject({
      platformMessageId: z.string().max(1024).optional(),
      data: z.json().optional(),
    }),
  }),
  retryOutcome,
  errorOutcome,
]);
function validateOutcome(
  input: unknown,
  kind: "dispatch" | "send",
): DispatchResult | SendResult {
  const result = (
    kind === "dispatch" ? dispatchOutcome : sendOutcome
  ).safeParse(input);
  return result.success
    ? (result.data as DispatchResult | SendResult)
    : { status: "unknown", errorCode: "invalid_plugin_outcome" };
}
async function boundedRequest(
  request: Request,
  maximum: number,
  timeoutMs: number,
): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const read = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new CoreError("body_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Request(request, { body: bytes });
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CoreError("request_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
