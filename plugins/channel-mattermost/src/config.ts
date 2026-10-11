import { z } from "zod";

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});

const requestTimeoutSchema = z.number().int().min(100).max(120_000).default(10_000);

export function validateBaseUrl(value: string, allowInsecureLocalhost: boolean): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    /[?#]/u.test(url.href) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowInsecureLocalhost))
  ) {
    throw new Error("invalid_base_url");
  }
  return url.href.replace(/\/$/u, "");
}

export const platformIdSchema = z.string().min(1).max(1024);
const configSchema = z.strictObject({
  serverUrl: z.url(),
  botUserId: platformIdSchema,
  token: secretRefSchema,
  allowInsecureLocalhost: z.boolean().default(false),
  timeoutMs: requestTimeoutSchema,
  reconnectMs: z.number().int().min(100).max(60_000).default(1000),
});
export type MattermostConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): MattermostConfig {
  const config = configSchema.parse(value);
  validateBaseUrl(config.serverUrl, config.allowInsecureLocalhost);
  return config;
}
