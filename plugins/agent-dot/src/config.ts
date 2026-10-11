import { z } from "zod";
import { callbackConfig } from "./callback.js";
import { mcpConfig } from "./mcp.js";

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  callback: callbackConfig,
  subscriptionTtlMs: z.number().int().min(1000).max(604_800_000).default(86_400_000),
  rotationWindowMs: z.number().int().min(1000).max(300_000).default(60_000),
});
export type DotConfig = z.infer<typeof configSchema>;
