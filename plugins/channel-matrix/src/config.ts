import { z } from "zod";
import { trustedBase, secretSchema, timeoutSchema } from "./protocol.js";

export const identifier = z.string().min(1).max(1024);
const configSchema = z.strictObject({
  homeserver: z.url(),
  userId: identifier,
  accessToken: secretSchema,
  allowInsecureLocalhost: z.boolean().default(false),
  timeoutMs: timeoutSchema,
  syncTimeoutMs: z.number().int().min(0).max(60_000).default(30_000),
  reconnectMs: z.number().int().min(100).max(60_000).default(1000),
});
export type MatrixConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): MatrixConfig {
  const config = configSchema.parse(value);
  trustedBase(config.homeserver, config.allowInsecureLocalhost);
  return config;
}
