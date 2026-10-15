# Mattermost

Use a dedicated Mattermost bot in channels and threads on your server.

## Prepare your account

Create a bot account and access token. Save the token as `MATTERMOST_TOKEN`; Add the bot to the intended channels with read/post permissions. For attachments it also needs `upload_file` and `read_channel` permissions.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Mattermost**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                      |
| ------------------ | -------------------------------------------------- |
| Server URL         | The server url obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#mattermost).

Use Mattermost user IDs in **Allowed user IDs** and channel IDs in **Chat ID**. The bot token can call `GET /api/v4/users/username/<username>` for a sender ID, and `GET /api/v4/teams/name/<team>/channels/name/<channel>` for a channel ID. A message event also contains `user_id` and `channel_id`. For a specific thread, set **Thread ID** to the root post ID.

## Enable the connection

Set `serverUrl` to the HTTPS base address of your Mattermost server. Start Relanox; it opens the server’s WebSocket connection automatically. Ensure your reverse proxy passes WebSocket connections and keep the process running.

The official [Mattermost JavaScript client](https://github.com/mattermost/mattermost/tree/master/webapp/platform/client) manages the connection, authentication, heartbeats and reconnects. Its in-memory event cursor can advance before Relanox finishes saving a post or downloading its attachments. Failed downloads, interruptions and restarts can therefore leave posts unaccepted; resend questions that still need an answer. Messages and deliveries already accepted by Core remain in the configured database and resume after restart.

## Send your first message

Send “Hello” from an allowed user in the bound channel. For a thread binding, reply under the root post. The bot posts the answer to the same channel/thread.

When the Agent specifies `reply.requestId`, the answer is posted as a native reply under that incoming post, or under its existing thread root. Sending without `reply` posts an ordinary message in the bound channel or thread. File attachments follow the same reply target.

## Images and files

Attach images, audio, videos or files as usual. Relanox uploads generated files through the SDK as native post attachments, and Mattermost creates available previews. Relanox defaults to 100 MiB per attachment and for all attachments in one message; configured media limits also bound incoming downloads. The server decides its upload limit, so this resource budget does not guarantee that it accepts a 100 MiB file. Oversized uploads are rejected, rate limits defer delivery, and uncertain post-send results remain unknown rather than being retried as known refusals.

## Troubleshooting

For connection failures, verify the HTTPS server address, token and proxy WebSocket settings. For missing posts, check channel membership and IDs. If a message was sent while Relanox was disconnected, send the question again after reconnecting. For upload failures, check bot permissions and server file-size settings.
