# Mattermost

Use a dedicated Mattermost bot in channels and threads on your server.

## Prepare your account

Create a bot account and access token. Save the token as `MATTERMOST_TOKEN`; Add the bot to the intended channels with read/post permissions. For attachments it also needs `upload_file` and `read_channel` permissions.

## Fill in the configurator

Open the [connection configurator](../configuration.md), select **Mattermost**, and enter the account details and secret environment variable names obtained above. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field         | What to enter                                     |
| -------------------------- | ------------------------------------------------- |
| Server URL                 | Replace example: `https://mattermost.example.com` |
| Token environment variable | Variable name: `MATTERMOST_TOKEN`                 |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#mattermost).

Use Mattermost user IDs in **Allowed user IDs** and channel IDs in **Chat ID**. The bot token can call `GET /api/v4/users/username/<username>` for a sender ID, and `GET /api/v4/teams/name/<team>/channels/name/<channel>` for a channel ID. A message event also contains `user_id` and `channel_id`. For a specific thread, set **Thread ID** to the root post ID.

## Enable the connection

Set `serverUrl` to the HTTPS base address of your Mattermost server. Start Relanox; it opens the server’s WebSocket connection automatically. Ensure your reverse proxy passes WebSocket connections and keep the process running.

## Send your first message

Send “Hello” from an allowed user in the bound channel. For a thread binding, reply under the root post. The bot posts the answer to the same channel/thread.

## Images and files

Attach images, audio, videos or files as usual. Relanox sends generated files back as native post attachments, and Mattermost creates available previews. Respect the server’s upload-size setting and the Relanox media limit.

## Troubleshooting

For connection failures, verify the HTTPS server address, token and proxy WebSocket settings. For missing posts, check channel membership and IDs. If a message was sent while Relanox was disconnected, send the question again after reconnecting. For upload failures, check bot permissions and server file-size settings.
