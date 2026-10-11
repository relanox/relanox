import { z } from "zod";
import { identifier } from "./io.js";

const identitySchema = z.object({ id: identifier });
export const activitySchema = z.object({
  type: z.string(),
  id: identifier.optional(),
  channelId: z.string(),
  serviceUrl: z.url(),
  text: z.string().optional(),
  from: identitySchema,
  recipient: identitySchema,
  conversation: z.object({ id: identifier, tenantId: identifier.optional() }),
  channelData: z.object({ tenant: z.object({ id: identifier }) }),
  replyToId: identifier.optional(),
});
export const targetSchema = z.strictObject({
  appId: identifier,
  serviceUrl: z.url(),
  conversationId: identifier,
  tenantId: identifier,
  botId: identifier,
  userId: identifier,
  replyToId: identifier.optional(),
});
export const keysSchema = z.object({
  keys: z.array(
    z.object({ kid: identifier.optional(), endorsements: z.array(z.string()).optional() }),
  ),
});
export const receiptSchema = z.object({ id: identifier });
