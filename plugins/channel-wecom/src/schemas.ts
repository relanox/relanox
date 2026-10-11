import { z } from "zod";
import { resourceSchema } from "./media.js";

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
  image: resourceSchema.optional(),
  file: resourceSchema.optional(),
  video: resourceSchema.optional(),
  voice: z.object({ content: z.string() }).optional(),
  mixed: z
    .object({
      msg_item: z.array(
        z.object({
          msgtype: z.string(),
          file: resourceSchema.optional(),
          video: resourceSchema.optional(),
          text: z.object({ content: z.string() }).optional(),
          image: resourceSchema.optional(),
        }),
      ),
    })
    .optional(),
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
