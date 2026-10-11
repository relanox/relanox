import { z } from "zod";

export const targetSchema = z.object({ botId: z.string(), apiBaseUrl: z.string() });
const messageSchema = z.looseObject({
  message_id: z.number().int().positive(),
  message_thread_id: z.number().int().positive().optional(),
  from: z.looseObject({ id: z.number().int(), is_bot: z.boolean() }).optional(),
  chat: z.looseObject({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
  }),
  text: z.string().max(1_048_576).optional(),
});
export const updateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
});
export const responseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.looseObject({ message_id: z.number().int() }).optional(),
  error_code: z.number().optional(),
  parameters: z.looseObject({ retry_after: z.number().positive().optional() }).optional(),
});
