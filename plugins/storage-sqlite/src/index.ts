import type { Storage, StoragePlugin } from "@relanox/sdk";
import { configSchema } from "./config.js";
import type { SqliteConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createLifecycle } from "./lifecycle.js";
import { createRequestOperations } from "./requests.js";
import { createWorkOperations } from "./work.js";
import { createStateOperations } from "./plugin-state.js";
import { createInspectionOperations } from "./inspection.js";

import { createMediaOperations } from "./media.js";

export type { SqliteConfig } from "./config.js";

export function createSqliteStorage(config: SqliteConfig): Storage {
  const context = openDatabase(config);
  return {
    media: createMediaOperations(context),
    ...createLifecycle(context),
    ...createRequestOperations(context),
    ...createWorkOperations(context),
    ...createStateOperations(context),
    ...createInspectionOperations(context),
  };
}

export const sqliteStoragePlugin: StoragePlugin<SqliteConfig> = {
  id: "sqlite",
  kind: "storage",
  sdkMajor: 1,
  runtime: "node",
  validateConfig: (input) => configSchema.parse(input),
  async setup(config) {
    return createSqliteStorage(config);
  },
};
