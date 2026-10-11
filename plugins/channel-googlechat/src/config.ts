import { z } from "zod";
import { endpoint, identifier, secretRef } from "./io.js";

const configSchema = z.strictObject({
  audience: identifier,
  callerEmail: z.email().default("chat@system.gserviceaccount.com"),
  issuer: z.string().default("https://accounts.google.com"),
  jwksUrl: z.url().default("https://www.googleapis.com/oauth2/v3/certs"),
  serviceAccount: secretRef,
  apiBase: z.url().default("https://chat.googleapis.com"),
  tokenUrl: z.url().default("https://oauth2.googleapis.com/token"),
  allowLoopback: z.boolean().default(false),
});
export type GoogleChatConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): GoogleChatConfig {
  const config = configSchema.parse(value);
  const apiBase = endpoint(config.apiBase, config.allowLoopback);
  if (/[?#]/u.test(apiBase.href)) {
    throw new Error("invalid_api_base");
  }
  config.apiBase = apiBase.href.replace(/\/+$/u, "");
  for (const url of [config.tokenUrl, config.jwksUrl]) {
    endpoint(url, config.allowLoopback);
  }
  return config;
}
