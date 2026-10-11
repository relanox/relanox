import { z } from "zod";
import { checkedUrl, secretRef } from "./transport.js";

export const configSchema = z
  .object({
    botId: z.string().min(1),
    secret: secretRef,
    wsUrl: z.url().default("wss://openws.work.weixin.qq.com"),
    allowInsecureLoopback: z.boolean().default(false),
    heartbeatMs: z.number().int().min(1000).max(60_000).default(30_000),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      checkedUrl(config.wsUrl, true, config.allowInsecureLoopback);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid secure WebSocket URL" });
    }
  });
export type WeComConfig = z.infer<typeof configSchema>;
