import { z } from "zod";
import { trustedBase, secretSchema, timeoutSchema } from "./protocol.js";

export const identifier = z.string().min(1).max(1024);
const configSchema = z.strictObject({
  serverUrl: z.url(),
  botUserId: identifier,
  token: secretSchema,
  allowInsecureLocalhost: z.boolean().default(false),
  timeoutMs: timeoutSchema,
  reconnectMs: z.number().int().min(100).max(60_000).default(1000),
});
export type MattermostConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): MattermostConfig {
  const config = configSchema.parse(value);
  trustedBase(config.serverUrl, config.allowInsecureLocalhost);
  return config;
}
