import { z } from "zod";
import { endpoint, identifier, secretRef } from "./io.js";

const configSchema = z.strictObject({
  appId: identifier,
  botId: identifier,
  tenantId: identifier,
  appSecret: secretRef,
  trustedServiceOrigins: z.array(z.url()).min(1),
  issuer: z.string().default("https://api.botframework.com"),
  jwksUrl: z.url().default("https://login.botframework.com/v1/.well-known/keys"),
  tokenUrl: z.url().default("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"),
  allowLoopback: z.boolean().default(false),
});
export type TeamsConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): TeamsConfig {
  const config = configSchema.parse(value);
  for (const url of [config.tokenUrl, config.jwksUrl, ...config.trustedServiceOrigins]) {
    endpoint(url, config.allowLoopback);
  }
  if (config.trustedServiceOrigins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error("service_origins_must_be_origins");
  }
  return config;
}
