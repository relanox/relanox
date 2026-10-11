import { z } from "zod";
import { checkedUrl, secretRef } from "./transport.js";

export const configSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: secretRef,
    robotCode: z.string().min(1),
    apiBase: z.url().default("https://api.dingtalk.com"),
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
export type DingTalkConfig = z.infer<typeof configSchema>;
