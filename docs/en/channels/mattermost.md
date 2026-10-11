# Mattermost

Use a dedicated Mattermost bot in channels and threads on your server.

## Prepare your account

Create a bot account and access token. Record its user ID and save the token as `MATTERMOST_TOKEN`. Add the bot to the intended channels with read/post permissions. For attachments it also needs `upload_file` and `read_channel` permissions.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "mattermost-main",
      "config": {
        "serverUrl": "https://mattermost.example.com",
        "botUserId": "dedicated_bot_user_id",
        "token": {
          "env": "MATTERMOST_TOKEN"
        }
      },
      "channel": "mattermost",
      "allowedSenders": ["dedicated_sender_id"]
    }
  ],
  "bindings": [
    {
      "accountId": "mattermost-main",
      "chatId": "dedicated_channel_id",
      "endpointId": "my-agent"
    }
  ]
}
```

Use Mattermost user IDs in `allowedSenders` and channel IDs in `chatId`. The bot token can call `GET /api/v4/users/me` for its own ID, `GET /api/v4/users/username/<username>` for a sender ID, and `GET /api/v4/teams/name/<team>/channels/name/<channel>` for a channel ID. A message event also contains `user_id` and `channel_id`. For a specific thread, set `threadId` to the root post ID.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Set `serverUrl` to the HTTPS base address of your Mattermost server. Start Relanox; it opens the server’s WebSocket connection automatically. Ensure your reverse proxy passes WebSocket connections and keep the process running.

## Send your first message

Send “Hello” from an allowed user in the bound channel. For a thread binding, reply under the root post. The bot posts the answer to the same channel/thread.

## Images and files

Attach images, audio, videos or files as usual. Relanox sends generated files back as native post attachments, and Mattermost creates available previews. Respect the server’s upload-size setting and the Relanox media limit.

## Troubleshooting

For connection failures, verify the HTTPS server address, token and proxy WebSocket settings. For missing posts, check channel membership and IDs. If a message was sent while Relanox was disconnected, send the question again after reconnecting. For upload failures, check bot permissions and server file-size settings.
