import { z } from "zod";
import type { DispatchResult, SendResult } from "@relanox/sdk";

const errorOutcome = z.strictObject({
  status: z.enum(["rejected", "unknown"]),
  errorCode: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
});

const retryOutcome = z.strictObject({
  status: z.literal("retryable"),
  errorCode: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
  retryAfterMs: z.number().nonnegative().optional(),
});

const dispatchOutcome = z.union([
  z.strictObject({ status: z.literal("accepted") }),
  retryOutcome,
  errorOutcome,
]);

const sendOutcome = z.union([
  z.strictObject({
    status: z.literal("sent"),
    receipt: z.strictObject({
      platformMessageId: z.string().max(1024).optional(),
      data: z.json().optional(),
    }),
  }),
  retryOutcome,
  errorOutcome,
]);

export function validateDispatchOutcome(input: unknown): DispatchResult {
  const result = dispatchOutcome.safeParse(input);
  return result.success
    ? (result.data as DispatchResult)
    : { status: "unknown", errorCode: "invalid_plugin_outcome" };
}

export function validateSendOutcome(input: unknown): SendResult {
  const result = sendOutcome.safeParse(input);
  return result.success
    ? (result.data as SendResult)
    : { status: "unknown", errorCode: "invalid_plugin_outcome" };
}
