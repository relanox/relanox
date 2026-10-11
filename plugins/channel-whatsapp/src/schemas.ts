import { z } from "zod";
import { identifier } from "./io.js";

export const messageSchema = z.object({
  id: identifier,
  from: identifier,
  timestamp: z.string().regex(/^[0-9]+$/u),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});
const valueSchema = z.object({
  metadata: z.object({ phone_number_id: identifier }),
  messages: z.array(messageSchema).optional(),
});
export const webhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: identifier,
      changes: z.array(z.object({ field: z.string(), value: valueSchema })),
    }),
  ),
});
export const targetSchema = z.strictObject({
  phoneNumberId: identifier,
  businessAccountId: identifier,
  apiBase: z.url(),
  customer: identifier,
  windowUntil: z.number().int().nonnegative(),
});
export const responseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  messages: z.array(z.object({ id: identifier })).min(1),
});
