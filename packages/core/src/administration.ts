import type { Health, Storage } from "@relanox/sdk";
import { z } from "zod";
import type { CoreRuntime } from "./types.js";
import { textId, limit } from "./validation.js";

type Administration = Pick<CoreRuntime, "health" | "status" | "cleanup" | "requeue">;

/** Operational reads and explicit recovery preserve the storage version and retention guards. */
export function createAdministration(
  storage: Storage,
  connections: ReadonlyMap<string, string>,
): Administration {
  async function health(): Promise<Health> {
    try {
      return await storage.health();
    } catch {
      return { ok: false, errorCode: "storage_unavailable" };
    }
  }

  return {
    health,
    async status(filter) {
      const bounded = { ...filter, limit: limit(filter?.limit ?? 100) };
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
    cleanup: (input) =>
      storage.cleanup({
        before: z.number().int().nonnegative().max(Date.now()).parse(input.before),
        limit: limit(input.limit),
      }),
    requeue: (input) =>
      storage.requeue({
        ...input,
        id: textId.parse(input.id),
        expectedVersion: z.number().int().positive().parse(input.expectedVersion),
        now: Date.now(),
      }),
  };
}
