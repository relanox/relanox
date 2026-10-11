import { z } from "zod";

export const secretRef = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});
export const mcpConfig = z.strictObject({
  token: secretRef,
  allowedHosts: z.array(z.string().min(1).max(255)).min(1),
  allowedOrigins: z.array(z.url()).default([]),
  maxBodyBytes: z.number().int().min(1024).max(2_097_152).default(1_048_576),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
});
export type McpConfig = z.infer<typeof mcpConfig>;
export const callbackConfig = z.strictObject({
  allowedOrigins: z.array(z.url()).min(1).max(100),
  transport: z.enum(["public-https", "loopback-http"]).default("public-https"),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
});
export type CallbackConfig = z.infer<typeof callbackConfig>;

export const configSchema = z.strictObject({
  mcp: mcpConfig,
  callback: callbackConfig,
  subscriptionTtlMs: z.number().int().min(1000).max(604_800_000).default(86_400_000),
  rotationWindowMs: z.number().int().min(1000).max(300_000).default(60_000),
});
export type DotConfig = z.infer<typeof configSchema>;
