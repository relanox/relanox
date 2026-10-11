import { z } from "zod";
import { address, id, secret, transportOptions } from "./transport.js";

const configSchema = z.strictObject({
  appId: id,
  appSecret: secret,
  verificationToken: secret,
  encryptKey: secret,
  tenantKey: id,
  botOpenId: id,
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  apiBaseUrl: z.string().optional(),
  ...transportOptions,
});
export type FeishuConfig = z.infer<typeof configSchema>;

export function validateConfig(input: unknown): FeishuConfig {
  const parsed = configSchema.parse(input);
  if (parsed.apiBaseUrl) {
    address(parsed.apiBaseUrl, parsed.allowInsecureLoopback);
  }
  return parsed;
}
