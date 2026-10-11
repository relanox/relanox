# WeCom intelligent robot

Use a WeCom intelligent robot in direct and group conversations.

## Prepare your account

Create and enable an intelligent robot with long-connection access. Record its bot ID and save its secret as `WECOM_BOT_SECRET`. Give the intended members access to it and add it to the group you want to use. Run one Relanox process for this robot.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **WeCom**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                  |
| ------------------ | ---------------------------------------------- |
| Bot ID             | The bot id obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#wecom).

## Discover user and group IDs

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

Start Relanox to connect automatically to the robot. Keep the process running.

## Send your first message

Send “Hello” directly to the robot. In a bound group, mention the robot with your question. Check that your enterprise member userid is allowed.

## Images and files

Send images, videos, files or mixed text/image messages. Voice input supplies its recognized text to the agent. Media downloads expire after five minutes, so keep Relanox online when sending them. Replies can include PNG/JPEG/GIF images and MP4 video up to 10 MiB, AMR audio up to 2 MiB, and files up to 20 MiB, subject to the relay limit.

## Troubleshooting

For a replaced connection, stop the other process using the same bot, then restart this instance. For missing group questions, check bot membership and mention it. If credentials changed, update the environment of the running service and restart it.

If discovery prints no conversation, verify the Bot ID and secret, check member access and group membership, then send another message while discovery is running. A discovery timeout alone does not confirm successful platform authentication.
