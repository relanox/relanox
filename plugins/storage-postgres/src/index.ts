import type { Storage, StoragePlugin, Observability } from "@relanox/sdk";
import { noopObservability } from "@relanox/sdk";
import type { z } from "zod";
import { configSchema } from "./config.js";
import type { PostgresConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createLifecycle } from "./lifecycle.js";
import { createRequestOperations } from "./requests.js";
import { createWorkOperations } from "./work.js";
import { createStateOperations } from "./plugin-state.js";
import { createInspectionOperations } from "./inspection.js";

export type { PostgresConfig } from "./config.js";

export function createPostgresStorage(
  configuration: z.input<typeof configSchema>,
  observe: Observability = noopObservability,
): Storage {
  const context = openDatabase(configuration, observe);
  return {
    ...createLifecycle(context),
    ...createRequestOperations(context),
    ...createWorkOperations(context),
    ...createStateOperations(context),
    ...createInspectionOperations(context),
  };
}
export const postgresStoragePlugin: StoragePlugin<PostgresConfig> = {
  id: "postgres",
  kind: "storage",
  sdkMajor: 1,
  runtime: "node",
  validateConfig: (input) => configSchema.parse(input),
  async setup(config, observe) {
    return createPostgresStorage(config, observe);
  },
};
