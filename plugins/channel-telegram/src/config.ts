import { z } from "zod";
import { address, secret, transportOptions } from "./transport.js";

const configSchema = z.strictObject({
  botToken: secret,
  webhookSecret: secret,
  apiBaseUrl: z.string().default("https://api.telegram.org"),
  ...transportOptions,
});
export type TelegramConfig = z.infer<typeof configSchema>;

export function validateConfig(input: unknown): TelegramConfig {
  const parsed = configSchema.parse(input);
  address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  return parsed;
}
