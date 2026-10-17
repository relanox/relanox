# Slack

Use a Slack app to talk to your agent in channels, direct messages and threads.

## Prepare your account

Create and install a workspace app. Save its bot token as `SLACK_BOT_TOKEN` and signing secret as `SLACK_SIGNING_SECRET`. Record the app ID. Grant `chat:write`, the message-history scopes for the conversations you use, and `files:read` / `files:write` for files. Invite the app into the selected channels.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Slack**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                          |
| ------------------ | ------------------------------------------------------ |
| Application ID     | The application id obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#slack).

Open the member profile and use Copy member ID for **Allowed user IDs**. Open channel details and copy the channel ID for **Chat ID**; for DMs, obtain the conversation ID through the app’s conversation information API. Leave **Thread ID** empty for ordinary channel or DM messages. Replies to that binding appear directly in the conversation.

For a specific thread, set **Thread ID** to the root message’s `ts`; replies in that thread carry it as `thread_ts`. Create a root message first and copy its message link. For a link ending in `p1710000000000001`, the root timestamp is `1710000000.000001` (insert a decimal point before the final six digits). Use that timestamp as **Thread ID**, save/restart Relanox, then reply in that thread. Each thread needs its own exact binding; a binding without **Thread ID** does not select thread replies.

## Enable the connection

For HTTP reception, set the Events request URL to `https://relay.example.com/channels/slack-main/events`. Subscribe to the applicable `message.channels`, `message.groups`, `message.im`, `message.mpim` or `app_mention` events. Start Relanox before Slack verifies the URL. Alternatively, enable Socket Mode, enter an app token variable name instead of the signing secret, and grant that app token `connections:write`; Relanox then connects automatically. Choose either HTTP reception or Socket Mode and provide only the matching credential.

Relanox uses Slack's official Node SDK for API calls, uploads and Socket Mode. Events are acknowledged after Core accepts them. Failed acceptance leaves the event unacknowledged while the connection continues receiving, so Slack can redeliver it. The SDK manages connection recovery; keep Relanox running and check for unanswered messages after an interruption.

## Send your first message

Send “Hello” or mention the app in the configured conversation, depending on your subscribed events. If you configured a thread binding, reply inside that thread and open it to see the answer.

When the Agent specifies an incoming request in `reply.requestId`, Slack replies in that message's thread. Replies within an existing thread stay under its root message. Sending without `reply` posts an ordinary message in the bound conversation or thread.

## Images and files

Share images, audio, videos or files with your question. Relanox sends generated files back into the same channel/thread. Ensure the installed bot token has both file scopes, then reinstall the app after changing scopes.

The SDK and Slack enforce current upload size and format limits, including images in ordered text/image replies. Relanox keeps its configured media budget (100 MiB by default), bounds incoming downloads and preserves the native layout's text and payload budgets.

## Troubleshooting

If URL verification fails, check the public event URL and signing secret. If channel messages are missing, check event subscriptions and app membership. For Socket Mode failures, verify the app token and `connections:write`, then restart Relanox after updating its environment.
