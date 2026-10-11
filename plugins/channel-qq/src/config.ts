import { z } from "zod";
import { checkedUrl, secretRef } from "./transport.js";

export const configSchema = z
  .object({
    appId: z.string().min(1),
    clientSecret: secretRef,
    transport: z.literal("websocket").default("websocket"),
    apiBase: z.url().default("https://api.bot.qq.com"),
    allowProactive: z.boolean().default(false),
    allowInsecureLoopback: z.boolean().default(false),
    maxReconnectAttempts: z.number().int().min(0).max(1000).default(20),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      checkedUrl(config.apiBase, false, config.allowInsecureLoopback);
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
export type QqConfig = z.infer<typeof configSchema>;
