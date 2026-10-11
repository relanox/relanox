import { z } from "zod";

const secretRefSchema = z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u) }).strict();

export function validateTransportUrl(
  value: string,
  websocket: boolean,
  allowLoopback: boolean,
): string {
  const url = new URL(value);
  const secure = websocket ? "wss:" : "https:";
  const local = websocket ? "ws:" : "http:";
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== secure &&
      !(
        allowLoopback &&
        url.protocol === local &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  ) {
    throw new Error("insecure_transport_url");
  }
  return url.toString();
}

export const configSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: secretRefSchema,
    robotCode: z.string().min(1),
    apiBase: z.url().default("https://api.dingtalk.com"),
    uploadBase: z.url().default("https://oapi.dingtalk.com"),
    mediaOrigins: z.array(z.url()).default([]),
    allowInsecureLoopback: z.boolean().default(false),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((config, context) => {
    for (const origin of config.mediaOrigins) {
      if (new URL(origin).origin !== origin) {
        context.addIssue({ code: "custom", message: "Media origins must be exact origins" });
      }
    }
    try {
      validateTransportUrl(config.apiBase, false, config.allowInsecureLoopback);
      validateTransportUrl(config.uploadBase, false, config.allowInsecureLoopback);
      if (/[?#]/u.test(new URL(config.apiBase).href)) {
        context.addIssue({
          code: "custom",
          message: "API base URL cannot contain a query or fragment",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Invalid secure API URL" });
    }
  });

export type DingTalkConfig = z.infer<typeof configSchema>;
