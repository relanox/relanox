import { z } from "zod";
import { address, id, secret, transportOptions } from "./transport.js";

const configSchema = z.strictObject({
  botToken: secret,
  botUserId: id,
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
  address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  address(parsed.gatewayUrl, parsed.allowInsecureLoopback, true);
  if ((parsed.intents & (512 | 4096 | 32_768)) !== (512 | 4096 | 32_768)) {
    throw new Error("required_message_intents_missing");
  }
  return parsed;
}
