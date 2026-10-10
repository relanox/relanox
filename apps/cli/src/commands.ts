import { Command } from "commander";
import { z } from "zod";
import { missingSecrets, probeManagement, readStatus, withStorage } from "./admin.js";
import { readConfig } from "./config.js";
import { startRuntime, validateApp } from "./runtime.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const configOptions = z.object({ config: z.string().min(1) });
const numberOption = (min: number, max: number) =>
  z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(min).max(max));
async function configFrom(command: Command) {
  const options = configOptions.parse(command.optsWithGlobals());
  return validateApp(await readConfig(options.config));
}
async function run(command: Command): Promise<void> {
  const config = await configFrom(command);
  let requested = false;
  let signalShutdown = () => {
    requested = true;
  };
  const onSignal = () => {
    signalShutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const runtime = await startRuntime(config);
    printJson({
      ok: true,
      event: "started",
      businessUrl: runtime.businessUrl,
      managementUrl: runtime.managementUrl,
    });
    await new Promise<void>((resolve) => {
      signalShutdown = resolve;
      if (requested) {
        resolve();
      }
    });
    await runtime.stop();
    printJson({ ok: true, event: "stopped" });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
function addStatus(program: Command): void {
  program
    .command("status")
    .description("Read persisted work; content requires explicit opt-in")
    .option("--limit <number>", "Page size", "100")
    .option("--after-id <id>", "Exclusive ID cursor")
    .option("--endpoint-id <id>", "Endpoint scope")
    .option("--request-status <status>", "pending, claimed, completed, failed")
    .option("--delivery-status <status>", "pending, sent, rejected, unknown")
    .option("--include-content", "Include message/result text", false)
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      const options = z
        .object({
          limit: numberOption(1, 1000),
          afterId: z.string().optional(),
          endpointId: z.string().optional(),
          requestStatus: z.enum(["pending", "claimed", "completed", "failed"]).optional(),
          deliveryStatus: z.enum(["pending", "sent", "rejected", "unknown"]).optional(),
          includeContent: z.boolean(),
        })
        .parse(command.opts());
      const filter = {
        limit: options.limit,
        ...(options.afterId === undefined ? {} : { afterId: options.afterId }),
        ...(options.endpointId === undefined ? {} : { endpointId: options.endpointId }),
        ...(options.requestStatus === undefined ? {} : { requestStatus: options.requestStatus }),
        ...(options.deliveryStatus === undefined ? {} : { deliveryStatus: options.deliveryStatus }),
      };
      printJson(
        await withStorage(config, (storage) => readStatus(storage, filter, options.includeContent)),
      );
    });
}
function addRecovery(program: Command): void {
  program
    .command("requeue")
    .description(
      "Recover local persisted state with version fencing; unknown effects may duplicate",
    )
    .requiredOption("--kind <kind>", "request or delivery")
    .requiredOption("--id <id>", "Record ID")
    .requiredOption("--expected-version <number>", "Current durable version")
    .option("--acknowledge-unknown", "Acknowledge possible duplicate external effects", false)
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      const options = z
        .object({
          kind: z.enum(["request", "delivery"]),
          id: z.string().min(1).max(1024),
          expectedVersion: numberOption(1, Number.MAX_SAFE_INTEGER),
          acknowledgeUnknown: z.boolean(),
        })
        .parse(command.opts());
      const result = await withStorage(config, (storage) =>
        storage.requeue({ ...options, now: Date.now() }),
      );
      printJson(result);
      if (result.status !== "updated") {
        process.exitCode = 2;
      }
    });
  program
    .command("cleanup")
    .description("Redact eligible terminal text while preserving deduplication and unfinished work")
    .requiredOption("--before <epoch-ms>", "Exclusive retention boundary")
    .option("--limit <number>", "Maximum records", "100")
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      const input = z
        .object({ before: numberOption(0, Number.MAX_SAFE_INTEGER), limit: numberOption(1, 1000) })
        .parse(command.opts());
      printJson(await withStorage(config, (storage) => storage.cleanup(input)));
    });
}
export function createProgram(): Command {
  const program = new Command()
    .name("relanox")
    .version("0.1.0")
    .description("Resident native text relay")
    .requiredOption("-c, --config <path>", "JSON configuration path")
    .exitOverride()
    .configureOutput({ writeErr() {} });
  program
    .command("validate")
    .description("Validate all schemas without opening resources")
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      printJson({
        ok: true,
        accounts: config.relay.accounts.length,
        endpoints: config.relay.endpoints.length,
      });
    });
  program
    .command("migrate")
    .description("Apply explicit idempotent storage migrations")
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      await withStorage(config, (storage) => storage.migrate());
      printJson({ ok: true });
    });
  program
    .command("run")
    .description("Start listeners, connections, and durable worker")
    .action(async (_options: unknown, command: Command) => run(command));
  program
    .command("doctor")
    .description("Check storage/secrets without migrations or connection startup")
    .option("--management-url <url>", "Explicit running loopback management origin")
    .action(async (_options: unknown, command: Command) => {
      const config = await configFrom(command);
      const options = z.object({ managementUrl: z.url().optional() }).parse(command.opts());
      const health = await withStorage(config, (storage) => storage.health());
      const missing = missingSecrets(config);
      const running =
        options.managementUrl === undefined
          ? undefined
          : await probeManagement(options.managementUrl, config.server.startupTimeoutMs);
      const ok = health.ok && missing.length === 0 && (running?.ready ?? true);
      printJson({
        ok,
        storage: { ok: health.ok },
        missingSecrets: missing,
        running,
        connections:
          "Use runtime metrics for current connection state; offline doctor does not start connections",
      });
      if (!ok) {
        process.exitCode = 2;
      }
    });
  addStatus(program);
  addRecovery(program);
  return program;
}
