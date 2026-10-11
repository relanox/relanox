import { z } from "zod";

export const frameSchema = z.object({
  cmd: z.string().optional(),
  headers: z.object({ req_id: z.string().min(1) }),
  body: z.unknown().optional(),
  errcode: z.number().int().optional(),
});
export const messageSchema = z.object({
  msgid: z.string().min(1),
  aibotid: z.string().min(1),
  chatid: z.string().min(1).optional(),
  chattype: z.enum(["single", "group"]),
  from: z.object({ userid: z.string().min(1) }),
  msgtype: z.string(),
  text: z.object({ content: z.string().min(1) }).optional(),
});
export const targetSchema = z
  .object({
    chattype: z.enum(["single", "group"]),
    scope: z.object({ botId: z.string().min(1), wsUrl: z.url() }).strict(),
  })
  .strict();

export const botEventSchema = z.object({
  aibotid: z.string(),
  event: z.object({ eventtype: z.string() }),
});
