# Slack

Use a Slack app to talk to your agent in channels, direct messages and threads.

## Prepare your account

Create and install a workspace app. Save its bot token as `SLACK_BOT_TOKEN` and signing secret as `SLACK_SIGNING_SECRET`. Record the app ID; Relanox discovers the workspace and bot user IDs from the bot token at startup. Grant `chat:write`, the message-history scopes for the conversations you use, and `files:read` / `files:write` for files. Invite the app into the selected channels.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "slack-main",
      "channel": "slack",
      "allowedSenders": ["U123ABC"],
      "config": {
        "botToken": {
          "env": "SLACK_BOT_TOKEN"
        },
        "signingSecret": {
          "env": "SLACK_SIGNING_SECRET"
        },
        "appId": "A123ABC"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "slack-main",
      "chatId": "C123ABC",
      "endpointId": "my-agent",
      "threadId": "1710000000.000001"
    }
  ]
}
```

Open the member profile and use Copy member ID for `allowedSenders`. Open channel details and copy the channel ID for `chatId`; for DMs, obtain the conversation ID through the app’s conversation information API. Bot `auth.test` can identify the workspace and bot user. For a specific thread, set `threadId` to the root message’s `ts`; replies in that thread carry it as `thread_ts`. Create a root message first and copy its message link. For a link ending in `p1710000000000001`, the root timestamp is `1710000000.000001` (insert a decimal point before the final six digits). Use that timestamp as `threadId`, save/restart Relanox, then reply in that thread. Every received Slack message has a thread ID; each thread needs its own exact binding.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

For HTTP reception, set the Events request URL to `https://relay.example.com/channels/slack-main/events`. Subscribe to the applicable `message.channels`, `message.groups`, `message.im`, `message.mpim` or `app_mention` events. Start Relanox before Slack verifies the URL. Alternatively, enable Socket Mode, replace `signingSecret` with `appToken: {"env":"SLACK_APP_TOKEN"}`, and grant that app token `connections:write`; Relanox then connects automatically. Supply exactly one of `signingSecret` or `appToken`; Relanox selects the receive mode from that credential.

## Send your first message

Reply “Hello” or mention the app inside the configured thread, depending on your subscribed events. Replies appear in the message thread; follow the thread to see the answer.

## Images and files

Share images, audio, videos or files with your question. Relanox sends generated files back into the same channel/thread. Ensure the installed bot token has both file scopes, then reinstall the app after changing scopes.

## Troubleshooting

If URL verification fails, check the public event URL and signing secret. If channel messages are missing, check event subscriptions and app membership. For Socket Mode failures, verify the app token and `connections:write`, then restart Relanox after updating its environment.
