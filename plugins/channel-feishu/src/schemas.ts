import { z } from "zod";
import { id } from "./transport.js";

export const targetSchema = z.object({
  tenantKey: id,
  appId: id,
  botId: id,
  apiBaseUrl: z.string(),
});
const headerSchema = z.looseObject({
  event_id: id,
  event_type: id,
  app_id: id,
  tenant_key: id,
  token: id,
});
export const challengeSchema = z.looseObject({
  type: z.literal("url_verification"),
  token: id,
  challenge: id,
});
export const eventSchema = z.looseObject({
  schema: z.literal("2.0"),
  header: headerSchema,
  event: z.unknown(),
});
export const messageSchema = z.looseObject({
  sender: z.looseObject({
    sender_type: id,
    sender_id: z.looseObject({ open_id: id.optional() }),
    tenant_key: id.optional(),
  }),
  message: z.looseObject({
    message_id: id,
    chat_id: id,
    chat_type: id,
    message_type: id,
    content: z.string().max(1_048_576),
    create_time: z.string(),
    root_id: id.optional(),
    parent_id: id.optional(),
    thread_id: id.optional(),
  }),
});
export const apiSchema = z.looseObject({
  code: z.number().int(),
  data: z.looseObject({ message_id: id.optional() }).optional(),
});
