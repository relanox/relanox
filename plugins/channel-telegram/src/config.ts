import { z } from "zod";

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});

const transportOptions = {
  allowInsecureLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
};

export function validateTransportUrl(value: string, insecure: boolean, socket = false): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.href.includes("#") ||
    (!socket && url.href.includes("?"))
  ) {
    throw new Error("invalid_transport_url");
  }
  const secure = socket ? "wss:" : "https:";
  const local = socket ? "ws:" : "http:";
  if (
    url.protocol !== secure &&
    !(
      insecure &&
      url.protocol === local &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error("insecure_transport_url");
  }
  return url.toString();
}

const configSchema = z.strictObject({
  botToken: secretRefSchema,
  webhookSecret: secretRefSchema,
  apiBaseUrl: z.string().default("https://api.telegram.org"),
  ...transportOptions,
});

export type TelegramConfig = z.infer<typeof configSchema>;

export function validateConfig(input: unknown): TelegramConfig {
  const parsed = configSchema.parse(input);
  validateTransportUrl(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  return parsed;
}
