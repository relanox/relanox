# QQ robot

Use an official QQ robot in private conversations and groups that mention the bot.

## Prepare your account

Create and enable a robot on the QQ bot platform. Save its app ID and client secret, and obtain `GROUP_AND_C2C_EVENT` permission. Make the robot available to your test or production users and groups according to the app’s release status.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "qq-main",
      "channel": "qq",
      "allowedSenders": ["user-openid", "group-member-openid"],
      "config": {
        "appId": "123456789",
        "clientSecret": {
          "env": "QQ_CLIENT_SECRET"
        },
        "apiBase": "https://api.bot.qq.com",
        "allowProactive": false
      }
    }
  ],
  "bindings": [
    {
      "accountId": "qq-main",
      "chatId": "user-openid",
      "endpointId": "my-agent"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

For private messages, both the allowed sender and binding `chatId` use `author.user_openid`. For groups, use `author.member_openid` in the sender allowlist and `group_openid` as `chatId`. Obtain these from robot message events; they are platform OpenIDs, separate from visible QQ numbers.

## Enable the connection

Relanox connects automatically over WebSocket when it starts. Keep it running with outbound access to QQ’s API and gateway. The example uses replies to incoming messages; keep `allowProactive` false for this setup.

## Send your first message

Send “Hello” privately or mention the robot in the bound group. Ask for a short reply first: the platform gives private replies a 60-minute window with four replies per incoming message, and group replies a five-minute window with five replies.

## Images and files

Send native images, audio, videos and files. Generated replies use QQ attachments. Prepare PNG/JPEG images, MP4 video, SILK audio or ordinary files. QQ’s limits are 20 MB for images/audio, 30 MB for videos and 200 MB for files; the relay’s default 25 MiB limit may be lower. Reply text and each attachment consume separate reply slots.

## Troubleshooting

If the gateway refuses connection, check robot release status, app credentials and event permission. If a group message is missing, mention the bot and verify the group/member OpenIDs. If a delayed answer exceeds the reply window, send a new question. Enable `allowProactive:true` only after obtaining the platform permission and the recipient’s receiving preference.
