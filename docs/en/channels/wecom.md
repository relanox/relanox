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

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use the message’s `from.userid` for `allowedSenders`. A direct-chat binding uses that member’s userid as `chatId`; a group binding uses the callback `chatid`. Obtain these values from your robot’s authenticated message events rather than display names.

## Enable the connection

Start Relanox to connect automatically to `wss://openws.work.weixin.qq.com`. Keep the process running.

## Send your first message

Send “Hello” directly to the robot. In a bound group, mention the robot with your question. Check that your enterprise member userid is allowed.

## Images and files

Send images, videos, files or mixed text/image messages. Voice input supplies its recognized text to the agent. Media downloads expire after five minutes, so keep Relanox online when sending them. Replies can include PNG/JPEG/GIF images and MP4 video up to 10 MiB, AMR audio up to 2 MiB, and files up to 20 MiB, subject to the relay limit.

## Troubleshooting

For a replaced connection, stop the other process using the same bot, then restart this instance. For missing group questions, check bot membership and mention it. If credentials changed, update the environment of the running service and restart it.
