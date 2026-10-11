import { z } from "zod";
import { identifier } from "./config.js";

export const frameSchema = z.object({
  event: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  seq_reply: z.number().int().optional(),
  status: z.string().optional(),
});
export const postSchema = z.object({
  id: identifier,
  user_id: identifier,
  channel_id: identifier,
  message: z.string(),
  root_id: z.string().default(""),
  create_at: z.number().int().nonnegative(),
  type: z.string().default(""),
});

export const targetSchema = z.strictObject({ serverUrl: z.string(), botUserId: identifier });
