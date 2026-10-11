import { z } from "zod";
import { endpoint, identifier, secretRef } from "./io.js";

const configSchema = z.strictObject({
  phoneNumberId: identifier,
  businessAccountId: identifier,
  appSecret: secretRef,
  verifyToken: secretRef,
  accessToken: secretRef,
  apiVersion: z.string().regex(/^v[0-9]+\.[0-9]+$/u),
  apiBase: z.url().default("https://graph.facebook.com"),
  allowLoopback: z.boolean().default(false),
});
export type WhatsAppConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): WhatsAppConfig {
  const config = configSchema.parse(value);
  const apiBase = endpoint(config.apiBase, config.allowLoopback);
  if (/[?#]/u.test(apiBase.href)) {
    throw new Error("invalid_api_base");
  }
  config.apiBase = apiBase.href.replace(/\/+$/u, "");
  return config;
}
