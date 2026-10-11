import { z } from "zod";
import { endpoint, identifier, secretRef } from "./io.js";

const configSchema = z.strictObject({
  botUserId: identifier,
  channelSecret: secretRef,
  accessToken: secretRef,
  apiBase: z.url().default("https://api.line.me"),
  allowLoopback: z.boolean().default(false),
});
export type LineConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): LineConfig {
  const config = configSchema.parse(value);
  const apiBase = endpoint(config.apiBase, config.allowLoopback);
  if (/[?#]/u.test(apiBase.href)) {
    throw new Error("invalid_api_base");
  }
  return { ...config, apiBase: apiBase.href.replace(/\/$/u, "") };
}
