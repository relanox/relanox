# Choose a messaging channel

Choose the chat app you already use. Each guide starts with account preparation, then walks through configuration, connection and your first message.

For a first installation, you can follow the Telegram example in the [quick start](../getting-started.md), then replace it or add other channels.

| Channel                                | What to prepare                                 |
| -------------------------------------- | ----------------------------------------------- |
| [Telegram](telegram.md)                | Telegram bot token                              |
| [Discord](discord.md)                  | Discord bot and message permissions             |
| [Slack](slack.md)                      | Slack app and workspace authorization           |
| [Feishu / Lark](feishu.md)             | An internal app and an event subscription URL   |
| [WeCom](wecom.md)                      | Intelligent robot ID; secret or callback keys   |
| [DingTalk](dingtalk.md)                | App robot and Stream credentials                |
| [QQ](qq.md)                            | QQ bot App ID and secret                        |
| [Microsoft Teams](msteams.md)          | Azure bot, Teams app and tenant details         |
| [WhatsApp Business Cloud](whatsapp.md) | Business account, phone number and access token |
| [Google Chat](googlechat.md)           | Chat app and service account                    |
| [LINE](line.md)                        | Messaging API channel and access token          |
| [Matrix](matrix.md)                    | Bot account and homeserver address              |
| [Mattermost](mattermost.md)            | Bot account and server address                  |
| [Signal](signal.md)                    | signal-cli service with a registered account    |
| [IRC](irc.md)                          | IRC server and bot nickname                     |

Replies use Markdown automatically. Ask for a heading, list, code block or formatted link as needed; the appearance depends on the chat app. See [Markdown rendering](../reference/channels.md#markdown) for platform differences.

## After connecting a channel

In your [settings](../configuration.md), choose the allowed users, conversations or groups and the Agent that receives their messages. Complete the [Agent setup](../agents.md) for dot or Grok Bot, then send a message in the chosen conversation and check its reply.

A binding identifies a destination by account, chat and, where supported, thread. Sending to that destination uses the channel's native address and permissions. Some channels also need information from authenticated platform events: Teams needs conversation metadata, Feishu threads need a real message anchor, WeCom HTTP replies need a callback, and QQ and WhatsApp replies follow their platform windows. See [Destination availability](../reference/channels.md#destinations) before setting up sends to other bound conversations.

Each platform handles pictures and files in its own way. Read the file section in your channel guide, then use [Send pictures and files](../media.md) to configure download addresses and sizes as needed.

For manual configuration and protocol parameters, see the [channel technical reference](../reference/channels.md).
