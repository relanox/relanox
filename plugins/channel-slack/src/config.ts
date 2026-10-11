import { z } from "zod";
import { address, id, secret, transportOptions } from "./transport.js";

const common = {
  botToken: secret,
  botUserId: id,
  teamId: id,
  appId: id,
  apiBaseUrl: z.string().default("https://slack.com/api"),
  reconnectDelayMs: z.number().int().min(100).max(30_000).default(1000),
  ...transportOptions,
};
const configSchema = z.discriminatedUnion("receiveMode", [
  z.strictObject({
    ...common,
    receiveMode: z.literal("http"),
    signingSecret: secret,
  }),
  z.strictObject({
    ...common,
    receiveMode: z.literal("socket"),
    appToken: secret,
  }),
]);
export type SlackConfig = z.infer<typeof configSchema>;

export function validateConfig(input: unknown): SlackConfig {
  const parsed = configSchema.parse(input);
  address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  return parsed;
}
