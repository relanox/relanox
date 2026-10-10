import { createDiscordChannel } from "@relanox/channel-discord";
import { createSlackChannel } from "@relanox/channel-slack";
import { createWeComChannel } from "@relanox/channel-wecom";
import { createDingTalkChannel } from "@relanox/channel-dingtalk";
import { createQqChannel } from "@relanox/channel-qq";
import { createMatrixChannel } from "@relanox/channel-matrix";
import { createMattermostChannel } from "@relanox/channel-mattermost";
import { createSignalChannel } from "@relanox/channel-signal";
import { createIrcChannel } from "@relanox/channel-irc";

/** Slack can alternatively receive HTTP Events; its factory also owns Socket Mode lifecycle. */
export const connectedChannelFactories = {
  discord: createDiscordChannel,
  slack: createSlackChannel,
  wecom: createWeComChannel,
  dingtalk: createDingTalkChannel,
  qq: createQqChannel,
  matrix: createMatrixChannel,
  mattermost: createMattermostChannel,
  signal: createSignalChannel,
  irc: createIrcChannel,
};
