import { z } from "zod";
import { identifier } from "./config.js";

const messageSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  message: z.string().nullable().optional(),
  groupInfo: z.object({ groupId: identifier }).nullable().optional(),
  viewOnce: z.boolean().nullable().optional(),
});
const envelopeSchema = z.object({
  source: identifier.nullable().optional(),
  sourceNumber: identifier.nullable().optional(),
  sourceUuid: identifier.nullable().optional(),
  timestamp: z.number().int().nonnegative(),
  dataMessage: messageSchema.nullable().optional(),
});
export const receiveSchema = z.object({ envelope: envelopeSchema, account: identifier.optional() });
export const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("direct"),
    recipient: identifier,
    serviceUrl: z.string(),
    account: identifier,
  }),
  z.strictObject({
    kind: z.literal("group"),
    groupId: identifier,
    serviceUrl: z.string(),
    account: identifier,
  }),
]);
export const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z
    .object({
      timestamp: z.number().int().nonnegative(),
      results: z
        .array(z.object({ type: z.string() }))
        .min(1)
        .optional(),
    })
    .optional(),
  error: z.object({ code: z.number().int() }).optional(),
});
