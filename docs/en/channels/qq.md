# QQ robot

Use an official QQ robot in private conversations and groups that mention the bot.

## Prepare your account

Create and enable a robot on the QQ bot platform. Save its app ID and client secret, and obtain `GROUP_AND_C2C_EVENT` permission. Make the robot available to your test or production users and groups according to the app’s release status.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **QQ robot**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                          |
| ------------------ | ------------------------------------------------------ |
| Application ID     | The application id obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#qq).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

For private messages, both the allowed sender and binding **Chat ID** use `author.user_openid`. For groups, use `author.member_openid` in the sender allowlist and `group_openid` as **Chat ID**. Obtain these from robot message events; they are platform OpenIDs, separate from visible QQ numbers.

QQ uses production by default; select sandbox in the configurator for a test account.

For proactive sends to a bound destination, add `recipientTypes` to the downloaded account's `config`: map its **Chat ID** to `c2c` for a private user or `group` for a group. This supplies the native address type; it does not grant permission to send proactively. Relanox uses passive replies while the incoming message's reply window is valid, and proactive messages otherwise. QQ decides whether platform permissions, quotas and the recipient's receiving preference permit the send. Leave **Thread ID** empty. See the [manual example](../reference/channels.md#qq).

## Enable the connection

Relanox connects automatically over WebSocket when it starts. Keep it running with outbound access to QQ’s API and gateway.

## Send your first message

Send “Hello” privately or mention the robot in the bound group. Ask for a short reply first: the platform gives private replies a 60-minute window with four replies per incoming message, and group replies a five-minute window with five replies.

## Images and files

Send native images, audio, videos and files. Generated replies use QQ attachments. Prepare PNG/JPEG images, MP4 video, SILK audio or ordinary files. Relanox defaults to 100 MB per attachment and per message; QQ uploads use the official SDK, with size acceptance determined by the SDK and platform. QQ’s limits are 20 MB for images/audio, 30 MB for videos and 200 MB for files. Reply text and each attachment consume separate reply slots.

If an attachment download fails, the message still arrives with the image's remote URL, a file/video description, or QQ's voice recognition text when available. A voice without recognized text carries an unavailable-transcription hint. Other successful attachments remain accessible. An image URL can expire and does not guarantee readable image content.

## Troubleshooting

If the gateway refuses connection, check robot release status, app credentials and event permission. If a group message is missing, mention the bot and verify the group/member OpenIDs. If QQ rejects a proactive message, check the robot's platform permissions and the recipient's receiving preference. Send a new question to open a passive reply window when proactive messages are unavailable.

When upgrading from a configuration containing `allowProactive`, remove that field before starting the new version. There is no Relanox switch for proactive QQ messages.
