# WeCom intelligent robot

Use a WeCom intelligent robot in direct and group conversations.

## Prepare your account

Create and enable an intelligent robot. Choose WebSocket (long connection) or HTTP callback access in its platform settings. For WebSocket, record its bot ID and save its secret as `WECOM_BOT_SECRET`. For HTTP callback, record its bot ID, Token and EncodingAESKey; save the latter two as `WECOM_TOKEN` and `WECOM_ENCODING_AES_KEY`. Give the intended members access to it and add it to the group you want to use. Run one Relanox process for this robot.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **WeCom**, choose the matching **Connection mode** (`websocket` or `webhook`), and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                  |
| ------------------ | ---------------------------------------------- |
| Bot ID             | The bot id obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#wecom).

## Discover user and group IDs with WebSocket

The discovery command requires WebSocket mode. For HTTP callback mode, obtain the member userid from your enterprise directory and the chat ID from the platform callback event.

Fill in the bot ID in the configurator and keep the default credential variable name, then download the draft as `relanox.json`. Leave allowed users and chat IDs empty for now. Set `WECOM_BOT_SECRET` in the terminal where you run the command.

Stop any service using the same robot before discovery: WeCom replaces its previous connection when another process connects. Run:

The default account ID is `wecom-main`. For another robot, replace it in the command with that robot’s account ID from the downloaded configuration.

```sh
node apps/cli/dist/main.js discover --config relanox.json --account wecom-main --timeout 120
```

Wait for `discovery_connected` in the terminal, then send a direct message to the robot or mention it in the target group. The terminal shows the conversation and sender IDs.

Ask each intended member to send a message if you need their userid. Use these IDs rather than display names.

Put the returned `senderId` in **Allowed user IDs** and `chatId` in **Chat ID** in the configurator. Finish the remaining fields and download the configuration again. Discovery stops after 120 seconds; Ctrl+C stops it early. Validate the finished configuration, then start the service again:

```sh
node apps/cli/dist/main.js validate --config relanox.json
```

## Enable the connection

In WebSocket mode, start Relanox to connect automatically to the robot. Keep the process running.

For WebSocket sends before Relanox receives a message in a bound conversation, add `recipientTypes` to the downloaded account's `config`: map the conversation's **Chat ID** to `single` or `group`. Otherwise, Relanox learns the type from authenticated message events. Use the exact member userid or group chat ID and keep **Thread ID** empty. See the [manual example](../reference/channels.md#wecom).

For HTTP callback mode, start Relanox behind your public HTTPS address, then enter the generated callback URL in the robot settings: `https://your-host/channels/wecom-main/webhook`. Replace `wecom-main` with your account ID. Use the same Token and EncodingAESKey as the service environment, and save the platform settings after URL verification succeeds.

HTTP mode needs a real authenticated message callback and an available reply window. Configuring a chat ID alone cannot open a reply destination; `recipientTypes` applies only to WebSocket mode.

Both modes require a public HTTPS address for dot or Grok MCP access.

## Send your first message

Send “Hello” directly to the robot. In a bound group, mention the robot with your question. Check that your enterprise member userid is allowed.

## Images and files

WebSocket mode accepts images, videos, files or mixed text/image messages. Voice input supplies its recognized text to the agent. Media downloads expire after five minutes, so keep Relanox online when sending them. Replies can include PNG/JPEG/GIF images and MP4 video up to 10 MB, AMR audio up to 2 MB, and files up to 20 MB, subject to the relay limit.

HTTP callback mode accepts text, images, videos, files, mixed text/image messages and voice transcription. Send one final Markdown reply per incoming message, with up to 10 PNG/JPEG images of 10 MB each, subject to the relay limit. Keep the total reply text within 20,480 UTF-8 bytes. The complete reply appears when it is ready. Keep Relanox online and its callback address reachable while waiting. Audio, video and file replies are unavailable in this mode.

Both modes preserve Markdown formatting where WeCom supports it.

## Troubleshooting

For a replaced connection, stop the other process using the same bot, then restart this instance. For missing group questions, check bot membership and mention it. If credentials changed, update the environment of the running service and restart it.

If discovery prints no conversation, verify the Bot ID and secret, check member access and group membership, then send another message while discovery is running. A discovery timeout alone does not confirm successful platform authentication.

For callback URL verification failures, check public HTTPS reachability, the account ID in the URL, and the Token and EncodingAESKey values.
