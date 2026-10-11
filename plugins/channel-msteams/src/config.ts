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
  appId: platformIdSchema,
  botId: platformIdSchema,
  tenantId: platformIdSchema,
  appSecret: secretRefSchema,
  mediaOrigins: z.array(z.url()).default([]),
  trustedUploadOrigins: z.array(z.url()).default([]),
  trustedServiceOrigins: z.array(z.url()).min(1),
  issuer: z.string().default("https://api.botframework.com"),
  jwksUrl: z.url().default("https://login.botframework.com/v1/.well-known/keys"),
  tokenUrl: z.url().default("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"),
  allowLoopback: z.boolean().default(false),
});
export type TeamsConfig = z.infer<typeof configSchema>;

export function validateConfig(value: unknown): TeamsConfig {
  const config = configSchema.parse(value);
  for (const url of [
    config.tokenUrl,
    config.jwksUrl,
    ...config.trustedServiceOrigins,
    ...config.mediaOrigins,
    ...config.trustedUploadOrigins,
  ]) {
    validateEndpointUrl(url, config.allowLoopback);
  }
  if (
    [...config.trustedServiceOrigins, ...config.mediaOrigins, ...config.trustedUploadOrigins].some(
      (origin) => new URL(origin).origin !== origin,
    )
  ) {
    throw new Error("service_origins_must_be_origins");
  }
  return config;
}
