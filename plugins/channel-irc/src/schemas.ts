import { z } from "zod";
import { nicknameSchema, channelSchema } from "./config.js";

export const recipientSchema = z.union([nicknameSchema, channelSchema]);
export const targetSchema = z.strictObject({
  recipient: recipientSchema,
  server: z.string(),
  port: z.number().int(),
  tls: z.boolean(),
});
