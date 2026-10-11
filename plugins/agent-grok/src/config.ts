import { z } from "zod";
import { mcpConfig, secretRef } from "./mcp.js";

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  routineUrl: secretRef,
  routineAuthorization: secretRef,
  routineTransport: z.enum(["https", "loopback-http"]).default("https"),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  maxBodyBytes: z.number().int().min(1024).max(2_097_152).default(1_048_576),
});
export type GrokConfig = z.infer<typeof configSchema>;
