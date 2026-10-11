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
    botId: z.string().min(1),
    secret: secretRefSchema,
    wsUrl: z.url().default("wss://openws.work.weixin.qq.com"),
    allowInsecureLoopback: z.boolean().default(false),
    heartbeatMs: z.number().int().min(1000).max(60_000).default(30_000),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      validateTransportUrl(config.wsUrl, true, config.allowInsecureLoopback);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid secure WebSocket URL" });
    }
  });
export type WeComConfig = z.infer<typeof configSchema>;
