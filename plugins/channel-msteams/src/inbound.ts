import type { AccountConfig, ChannelHost } from "@relanox/sdk";
import type { z } from "zod";
import type { TeamsConfig } from "./config.js";
import { ingest } from "./io.js";
import type { activitySchema } from "./schemas.js";

export async function receive(
  host: ChannelHost,
  account: AccountConfig,
  config: TeamsConfig,
  activity: z.infer<typeof activitySchema>,
): Promise<void> {
  if (activity.type !== "message" || !activity.text || activity.from.id === config.botId) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  if (!activity.id) {
    throw new Error("missing_activity_id");
  }
  const threadId = activity.replyToId;
  await ingest(host, {
    source: {
      channel: "msteams",
      accountId: account.id,
      eventId: `${activity.conversation.id}:${activity.id}`,
    },
    senderId: activity.from.id,
    text: activity.text,
    receivedAt: Date.now(),
    context: { tenantId: config.tenantId },
    target: {
      channel: "msteams",
      accountId: account.id,
      chatId: activity.conversation.id,
      ...(threadId ? { threadId } : {}),
      replyToId: activity.id,
      data: {
        appId: config.appId,
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        tenantId: config.tenantId,
        botId: config.botId,
        userId: activity.from.id,
        replyToId: threadId ?? activity.id,
      },
    },
  });
}
