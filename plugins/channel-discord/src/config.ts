import { z } from "zod";

const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
});

export const platformIdSchema = z.string().min(1).max(256);

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
  botUserId: platformIdSchema,
  apiBaseUrl: z.string().default("https://discord.com/api/v10"),
  gatewayUrl: z.string().default("wss://gateway.discord.gg"),
  intents: z
    .number()
    .int()
    .nonnegative()
    .default(1 | 512 | 4096 | 32_768),
  reconnectDelayMs: z.number().int().min(100).max(30_000).default(5000),
  ...transportOptions,
});

export type DiscordConfig = z.infer<typeof configSchema>;

export function validateConfig(input: unknown): DiscordConfig {
  const parsed = configSchema.parse(input);
  validateTransportUrl(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  validateTransportUrl(parsed.gatewayUrl, parsed.allowInsecureLoopback, true);
  if ((parsed.intents & (512 | 4096 | 32_768)) !== (512 | 4096 | 32_768)) {
    throw new Error("required_message_intents_missing");
  }
  return parsed;
}
