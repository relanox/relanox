# Telegram

Talk to your agent in a Telegram bot chat, group or forum topic.

## Prepare your account

Create a bot with @BotFather and save its token as `TELEGRAM_BOT_TOKEN`. Choose a webhook secret using letters, digits, `_` and `-`, and save it as `TELEGRAM_WEBHOOK_SECRET`. Add the bot to your group if you want group conversations. Arrange a public HTTPS address for Relanox.

## Add the configuration

Before registering the webhook, send the bot a private “Hello”, then run this in PowerShell with `TELEGRAM_BOT_TOKEN` already set. Inspect `result[].message.from.id` and `result[].message.chat.id` in the output. For a group/topic ID, send a test message there and inspect its update too. A newly created bot is easiest for this step; an existing bot needs its current webhook removed before `getUpdates` works. Coordinate that change with its owner.

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates" |
  ConvertTo-Json -Depth 12
```

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "telegram-main",
      "channel": "telegram",
      "allowedSenders": ["123456789"],
      "config": {
        "botToken": {
          "env": "TELEGRAM_BOT_TOKEN"
        },
        "webhookSecret": {
          "env": "TELEGRAM_WEBHOOK_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "telegram-main",
      "chatId": "123456789",
      "endpointId": "my-agent"
    }
  ]
}
```

Use the decimal `from.id` as the allowed sender and `chat.id` as the binding chat ID. These fields are available in a bot message update. A private chat normally uses your user ID as its chat ID. Groups can have negative chat IDs: preserve the minus sign. For a forum topic, add its `message_thread_id` as the binding `threadId`, also as a string.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

After starting Relanox, call Telegram Bot API `setWebhook` with `url` set to `https://relay.example.com/channels/telegram-main/webhook`, `secret_token` set to your webhook secret, and `allowed_updates` set to `["message"]`. Replace the domain with your own. `getWebhookInfo` shows the registered address and recent delivery errors.

## Send your first message

Open the bot, press Start, then send “Hello”. In a group, address the bot with a mention or reply to it; adjust BotFather privacy settings if you want it to receive ordinary group messages. Send the message in the exact chat or topic you bound.

## Images and files

Attach a photo, voice message, audio, video or document as usual; a caption can carry your question. Received cloud files must fit Telegram’s 20 MiB download limit and your relay limit. Replies can contain images, audio, video and files. Photos are limited to 10 MiB and other uploads to 50 MiB, with the relay limit also applying.

## Troubleshooting

If the bot receives nothing, check `getWebhookInfo`, HTTPS reachability and the matching webhook secret. If only group messages are missing, check bot membership and privacy settings. If messages arrive but receive no answer, compare the sender, chat and topic IDs with your configuration.
