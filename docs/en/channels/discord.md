# Discord

Use a Discord bot in direct messages, server channels and threads.

## Prepare your account

Create an application and bot in the Discord developer portal. Save its token as `DISCORD_BOT_TOKEN`; enable Message Content Intent. Invite the bot with permission to view channels, send messages, access the intended threads and attach files.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Discord**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#discord).

Enable Developer Mode in Discord, then use Copy ID on the sender and channel. **Allowed user IDs** contains user IDs. An ordinary channel binding uses its channel ID; a thread uses its parent channel as **Chat ID** and the thread channel ID as **Thread ID**. For a DM, use the DM channel ID.

## Enable the connection

Start Relanox after adding the account. It connects to Discord automatically. Keep the process running and allow outbound HTTPS and WebSocket connections to Discord.

## Send your first message

Send “Hello” from an allowed user in the bound channel or DM. For a thread binding, open that thread first. The reply appears in the same conversation.

## Images and files

Attach images, audio, videos or files to your message, with or without text. The bot can send generated attachments back through Discord. Keep files within your Relanox media limit and the server’s Discord upload allowance.

## Troubleshooting

For missing text, verify Message Content Intent and the bot’s channel permissions. For missing thread replies, check both parent and thread IDs and thread access. If the bot cannot connect, check that the token belongs to the configured bot user.
