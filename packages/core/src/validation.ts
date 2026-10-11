import { CoreError } from "./errors.js";
import { z } from "zod";

export const textId = z.string().min(1).max(1024);
export const ingestSchema = z.strictObject({
  source: z.strictObject({
    channel: textId,
    accountId: textId,
    eventId: textId,
  }),
  senderId: textId,
  text: z.string(),
  target: z.strictObject({
    channel: textId,
    accountId: textId,
    chatId: textId,
    threadId: textId.optional(),
    replyToId: textId.optional(),
    data: z.json(),
  }),
  receivedAt: z.number().int().nonnegative(),
  context: z.json(),
  trace: z
    .strictObject({
      traceparent: z.string().regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u),
      tracestate: z.string().max(512).optional(),
    })
    .optional(),
});
export function limit(value: number): number {
  return z.number().int().min(1).max(1000).parse(value);
}

export function boundedText(text: string, maxTextBytes: number, nonempty = true): void {
  if (
    typeof text !== "string" ||
    (nonempty && text.length === 0) ||
    !text.isWellFormed() ||
    new TextEncoder().encode(text).length > maxTextBytes
  ) {
    throw new CoreError("invalid_text");
  }
}
