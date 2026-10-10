import type { Json, RelanoxConfig, SecretRef } from "@relanox/sdk";
import { z } from "zod";

export const channels = [
  "telegram",
  "discord",
  "slack",
  "feishu",
  "wecom",
  "dingtalk",
  "qq",
  "msteams",
  "whatsapp",
  "matrix",
  "googlechat",
  "line",
  "mattermost",
  "signal",
  "irc",
] as const;
export const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const opaque = z.string().min(1).max(1024);
const json = z.json();
export const configSchema = z
  .strictObject({
    accounts: z.array(
      z.strictObject({
        id,
        channel: z.enum(channels),
        config: json,
        allowedSenders: z.array(opaque).min(1),
      }),
    ),
    endpoints: z.array(
      z.strictObject({
        id,
        agent: z.enum(["dot", "grok"]),
        config: json,
        dispatchMode: z.enum(["push", "pull"]),
      }),
    ),
    bindings: z.array(
      z.strictObject({
        accountId: id,
        chatId: opaque,
        threadId: opaque.optional(),
        endpointId: id,
        allowedSenders: z.array(opaque).min(1).optional(),
      }),
    ),
    storage: z.strictObject({
      plugin: z.enum(["sqlite", "postgres"]),
      config: json,
    }),
    observability: z.strictObject({
      plugin: z.enum(["standard", "none"]),
      config: json,
    }),
  })
  .superRefine((value, ctx) => {
    for (const key of ["accounts", "endpoints"] as const) {
      const seen = new Set<string>();
      for (const item of value[key]) {
        if (seen.has(item.id))
          ctx.addIssue({
            code: "custom",
            message: `Duplicate ${key} id`,
            path: [key],
          });
        seen.add(item.id);
      }
    }
    const bindings = new Set<string>();
    for (const binding of value.bindings) {
      if (
        !value.accounts.some((a) => a.id === binding.accountId) ||
        !value.endpoints.some((e) => e.id === binding.endpointId)
      )
        ctx.addIssue({
          code: "custom",
          message: "Unknown binding account or endpoint",
          path: ["bindings"],
        });
      const key = bindingKey(
        binding.accountId,
        binding.chatId,
        binding.threadId,
      );
      if (bindings.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate conversation binding",
          path: ["bindings"],
        });
      bindings.add(key);
    }
  });
export function bindingKey(
  accountId: string,
  chatId: string,
  threadId?: string,
): string {
  return JSON.stringify([accountId, chatId, threadId ?? null]);
}
export function validateConfig(input: unknown): RelanoxConfig {
  return configSchema.parse(input) as RelanoxConfig;
}
/** Called by assembly/plugins at the point of use, never by durable snapshot creation. */
export function resolveSecretRef(
  ref: SecretRef,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const { env } = secretRefSchema.parse(ref);
  const value = environment[env];
  if (!value) throw new Error(`Missing environment secret: ${env}`);
  return value;
}
export function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function validateJson(value: unknown): Json {
  return json.parse(value) as Json;
}
