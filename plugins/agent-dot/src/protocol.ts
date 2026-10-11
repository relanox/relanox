import { z } from "zod";

export const name = "relanox.message_available";
const signingSecret = z
  .string()
  .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/u)
  .refine((value) => {
    const encoded = value.slice(6);
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length >= 24 && bytes.length <= 64 && bytes.toString("base64") === encoded;
  }, "Expected canonical whsec base64 key of 24-64 bytes");
// Route authentication already fixes the endpoint; no caller scope.
export const args = z.strictObject({});
const destination = z.strictObject({
  mode: z.literal("webhook"),
  url: z.url().max(4096),
});
export const requestMetadata = z.record(z.string(), z.json()).optional();
export const subscribeParams = z.strictObject({
  _meta: requestMetadata,
  name: z.literal(name),
  arguments: args,
  delivery: destination.extend({ secret: signingSecret }),
  cursor: z.null().optional(),
  ttlMs: z.number().int().min(1000).nullable().optional(),
});
export const unsubscribeParams = z.strictObject({
  _meta: requestMetadata,
  name: z.literal(name),
  arguments: args,
  delivery: destination,
});
export const subscriptionSchema = z.strictObject({
  id: z.string(),
  owner: z.string(),
  endpointId: z.string(),
  name: z.literal(name),
  arguments: args,
  url: z.url(),
  secret: signingSecret,
  expiresAt: z.number().int(),
  verifiedAt: z.number().int(),
  previousSecret: signingSecret.optional(),
  previousUntil: z.number().int().optional(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
