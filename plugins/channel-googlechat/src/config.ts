import { z } from "zod";

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});

export const platformIdSchema = z.string().min(1).max(1024);

export function validateEndpointUrl(value: string, allowLoopback: boolean): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
  ) {
    throw new Error("unsafe_endpoint");
  }
  return url;
}

const configSchema = z.strictObject({
  audience: platformIdSchema,
  callerEmail: z.email().default("chat@system.gserviceaccount.com"),
  issuer: z.string().default("https://accounts.google.com"),
  jwksUrl: z.url().default("https://www.googleapis.com/oauth2/v3/certs"),
  serviceAccount: secretRefSchema,
  apiBase: z.url().default("https://chat.googleapis.com"),
  tokenUrl: z.url().default("https://oauth2.googleapis.com/token"),
  allowLoopback: z.boolean().default(false),
});
export type GoogleChatConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): GoogleChatConfig {
  const config = configSchema.parse(value);
  const apiBase = validateEndpointUrl(config.apiBase, config.allowLoopback);
  if (/[?#]/u.test(apiBase.href)) {
    throw new Error("invalid_api_base");
  }
  config.apiBase = apiBase.href.replace(/\/+$/u, "");
  for (const url of [config.tokenUrl, config.jwksUrl]) {
    validateEndpointUrl(url, config.allowLoopback);
  }
  return config;
}
