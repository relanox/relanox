# QQ robot

Use an official QQ robot in private conversations and groups that mention the bot.

## Prepare your account

Create and enable a robot on the QQ bot platform. Save its app ID and client secret, and obtain `GROUP_AND_C2C_EVENT` permission. Make the robot available to your test or production users and groups according to the app’s release status.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **QQ robot**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field       | What to enter                                          |
| ------------------------ | ------------------------------------------------------ |
| Application ID           | The application id obtained during account preparation |
| Allow proactive messages | Initial value: `false`                                 |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#qq).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

For private messages, both the allowed sender and binding **Chat ID** use `author.user_openid`. For groups, use `author.member_openid` in the sender allowlist and `group_openid` as **Chat ID**. Obtain these from robot message events; they are platform OpenIDs, separate from visible QQ numbers.

QQ uses production by default; select sandbox in the configurator for a test account.

## Enable the connection

Relanox connects automatically over WebSocket when it starts. Keep it running with outbound access to QQ’s API and gateway. Keep **Allow proactive messages** disabled when replying to incoming messages.

## Send your first message

Send “Hello” privately or mention the robot in the bound group. Ask for a short reply first: the platform gives private replies a 60-minute window with four replies per incoming message, and group replies a five-minute window with five replies.

## Images and files

Send native images, audio, videos and files. Generated replies use QQ attachments. Prepare PNG/JPEG images, MP4 video, SILK audio or ordinary files. QQ’s limits are 20 MB for images/audio, 30 MB for videos and 200 MB for files; the relay’s default 25 MiB limit may be lower. Reply text and each attachment consume separate reply slots.

## Troubleshooting

If the gateway refuses connection, check robot release status, app credentials and event permission. If a group message is missing, mention the bot and verify the group/member OpenIDs. If a delayed answer exceeds the reply window, send a new question. Enable **Allow proactive messages** only after obtaining the platform permission and the recipient’s receiving preference.
