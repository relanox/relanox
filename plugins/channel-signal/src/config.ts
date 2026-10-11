import { z } from "zod";
import { trustedBase, secretSchema, timeoutSchema } from "./protocol.js";

export const identifier = z.string().min(1).max(240);
const configSchema = z.strictObject({
  serviceUrl: z.url(),
  account: identifier,
  selfUuid: identifier.optional(),
  authorization: secretSchema.optional(),
  allowInsecureLocalhost: z.boolean().default(false),
  timeoutMs: timeoutSchema,
  reconnectMs: z.number().int().min(100).max(60_000).default(1000),
});
export type SignalConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): SignalConfig {
  const config = configSchema.parse(value);
  trustedBase(config.serviceUrl, config.allowInsecureLocalhost);
  return config;
}
