# Discord

Use a Discord bot in direct messages, server channels and threads.

## Prepare your account

Create an application and bot in the Discord developer portal. Save its token as `DISCORD_BOT_TOKEN`; Relanox discovers the bot identity and Gateway address at startup. Enable Message Content Intent. Invite the bot with permission to view channels, send messages, access the intended threads and attach files.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "discord-main",
      "channel": "discord",
      "allowedSenders": ["123456789012345678"],
      "config": {
        "botToken": {
          "env": "DISCORD_BOT_TOKEN"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "discord-main",
      "chatId": "112233445566778899",
      "endpointId": "my-agent"
    }
  ]
}
```

Enable Developer Mode in Discord, then use Copy ID on the sender and channel. `allowedSenders` contains user IDs. An ordinary channel binding uses its channel ID; a thread uses its parent channel as `chatId` and the thread channel ID as `threadId`. For a DM, use the DM channel ID.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Start Relanox after adding the account. It connects to Discord automatically. Keep the process running and allow outbound HTTPS and WebSocket connections to Discord.

## Send your first message

Send “Hello” from an allowed user in the bound channel or DM. For a thread binding, open that thread first. The reply appears in the same conversation.

## Images and files

Attach images, audio, videos or files to your message, with or without text. The bot can send generated attachments back through Discord. Keep files within your Relanox media limit and the server’s Discord upload allowance.

## Troubleshooting

For missing text, verify Message Content Intent and the bot’s channel permissions. For missing thread replies, check both parent and thread IDs and thread access. If the bot cannot connect, check that the token belongs to the configured bot user.
