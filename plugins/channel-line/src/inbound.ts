import type { AccountConfig, ChannelHost } from "@relanox/sdk";
import type { z } from "zod";
import type { LineConfig } from "./config.js";
import { ingest } from "./io.js";
import { receiveMedia } from "./media.js";
import type { eventSchema } from "./schemas.js";

export async function receiveEvent(
  host: ChannelHost,
  account: AccountConfig,
  config: LineConfig,
  event: z.infer<typeof eventSchema>,
): Promise<void> {
  const { source, message } = event;
  if (
    event.type !== "message" ||
    !source ||
    !message ||
    !["text", "image", "audio", "video", "file"].includes(message.type) ||
    (message.type === "text" && !message.text) ||
    source.userId === config.botUserId
  ) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  if (!event.webhookEventId || !source.userId) {
    throw new Error("missing_event_identity");
  }
  let destination = source.userId;
  if (source.type === "group") {
    destination = source.groupId ?? "";
  }
  if (source.type === "room") {
    destination = source.roomId ?? "";
  }
  if (!destination) {
    throw new Error("missing_destination");
  }
  await ingest(host, {
    source: { channel: "line", accountId: account.id, eventId: event.webhookEventId },
    senderId: source.userId,
    text: message.text ?? "",
    attachments: await receiveMedia(message, host, config),
    receivedAt: Date.now(),
    context: null,
    target: {
      channel: "line",
      accountId: account.id,
      chatId: destination,
      replyToId: message.id,
      data: {
        destination,
        sourceType: source.type,
        botId: config.botUserId,
        apiBaseUrl: new URL(config.apiBase).toString().replace(/\/$/u, ""),
      },
    },
  });
}
