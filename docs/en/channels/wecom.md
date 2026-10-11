# WeCom intelligent robot

Use a WeCom intelligent robot in direct and group conversations.

## Prepare your account

Create and enable an intelligent robot with long-connection access. Record its bot ID and save its secret as `WECOM_BOT_SECRET`. Give the intended members access to it and add it to the group you want to use. Run one Relanox process for this robot.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "wecom-main",
      "channel": "wecom",
      "allowedSenders": ["staff-userid"],
      "config": {
        "botId": "intelligent-robot-id",
        "secret": {
          "env": "WECOM_BOT_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "wecom-main",
      "chatId": "staff-userid",
      "endpointId": "my-agent"
    }
  ]
}
```

## Discover user and group IDs

For first-time setup, save a draft `relanox.json` containing your WeCom entry in `relay.accounts`, with the real `botId` and secret environment reference. You can leave `allowedSenders` empty and bindings unfinished during discovery. Set `WECOM_BOT_SECRET` in the terminal environment. Agent credentials and database setup are not needed for this command.

Stop any service using the same robot before discovery: WeCom replaces its previous connection when another process connects. Run:

```sh
relanox discover --config relanox.json --account wecom-main --timeout 120
```

Wait for the terminal's `discovery_connected` event, then send a message directly to the robot, or mention it in the target group. The terminal prints a JSON line for each distinct conversation and sender:

```json
{
  "ok": true,
  "event": "conversation",
  "accountId": "wecom-main",
  "channel": "wecom",
  "chatId": "group-chatid",
  "senderId": "staff-userid"
}
```

Copy `senderId` into `allowedSenders` and `chatId` into the binding. A direct chat uses the member userid; a group uses the authenticated callback's `chatid`. Ask each intended member to send a message if you need their userid. Use these IDs rather than display names.

Discovery supports WeCom only. It stops after 120 seconds by default; `--timeout` accepts 1–600 seconds, and Ctrl+C stops it early. It prints only account, conversation and sender IDs, with no message text, media URLs or credentials. It does not download attachments, save messages or dispatch to an Agent. The normal service still requires configured bindings and sender allowlists. Finish the configuration, run `relanox validate --config relanox.json`, then start the service again.

## Enable the connection

Start Relanox to connect automatically to `wss://openws.work.weixin.qq.com`. Keep the process running.

## Send your first message

Send “Hello” directly to the robot. In a bound group, mention the robot with your question. Check that your enterprise member userid is allowed.

## Images and files

Send images, videos, files or mixed text/image messages. Voice input supplies its recognized text to the agent. Media downloads expire after five minutes, so keep Relanox online when sending them. Replies can include PNG/JPEG/GIF images and MP4 video up to 10 MiB, AMR audio up to 2 MiB, and files up to 20 MiB, subject to the relay limit.

## Troubleshooting

For a replaced connection, stop the other process using the same bot, then restart this instance. For missing group questions, check bot membership and mention it. If credentials changed, update the environment of the running service and restart it.

If discovery prints no conversation, verify the Bot ID and secret, check member access and group membership, then send another message while discovery is running. A discovery timeout alone does not confirm successful platform authentication.
