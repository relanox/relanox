import { createTelegramChannel } from "@relanox/channel-telegram";
import { createFeishuChannel } from "@relanox/channel-feishu";
import { createTeamsChannel } from "@relanox/channel-msteams";
import { createWhatsAppChannel } from "@relanox/channel-whatsapp";
import { createGoogleChatChannel } from "@relanox/channel-googlechat";
import { createLineChannel } from "@relanox/channel-line";

export const httpChannelFactories = {
  telegram: createTelegramChannel,
  feishu: createFeishuChannel,
  msteams: createTeamsChannel,
  whatsapp: createWhatsAppChannel,
  googlechat: createGoogleChatChannel,
  line: createLineChannel,
};
