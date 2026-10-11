# LINE

Connect a LINE Official Account to answer private, group and room messages.

## Prepare your account

Create an Official Account with a Messaging API channel. Save its channel secret and access token in the environment variables below. Relanox discovers the bot identity from the access token at startup. Add the Official Account as a friend, or invite it into the intended group/room. Check that your plan has enough push-message quota.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "line-main",
      "config": {
        "channelSecret": {
          "env": "LINE_CHANNEL_SECRET"
        },
        "accessToken": {
          "env": "LINE_ACCESS_TOKEN"
        }
      },
      "channel": "line",
      "allowedSenders": ["U_example_user"]
    }
  ],
  "bindings": [
    {
      "accountId": "line-main",
      "chatId": "G_example_group",
      "endpointId": "my-agent"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use event `source.userId` in `allowedSenders`. For a private conversation use that user ID as `chatId`; for a group use `source.groupId`, and for a room use `source.roomId`. The example is a group binding. Relanox checks webhook destinations against the discovered bot identity.

## Enable the connection

Enable Webhooks and set the URL to `https://relay.example.com/channels/line-main/webhook`. Start Relanox, then use the platform’s webhook verification. Enable webhook redelivery if you want LINE to retry failed event delivery.

## Send your first message

Send “Hello” from an allowed user to the Official Account or into the bound group/room. The reply is sent by the Official Account to that conversation.

## Images and files

Send images, audio, videos or files with your question. Image, audio and video replies need `publicUrl`; follow [Media](../media.md) to expose it over HTTPS. Use JPEG/PNG images up to 10 MB. Images larger than 1 MB (1,000,000 bytes) and every MP4 video require a JPEG/PNG preview up to 1 MB. Generated audio uses MP3/M4A with a duration. Audio/video can be up to 200 MB, within your relay limit.

## Troubleshooting

If webhook verification fails, check that the channel secret and access token belong to the same Official Account. For missing group messages, enable group access for the Official Account and confirm its membership. If text works but media replies fail, verify the HTTPS media address, preview image and duration; check push quota for all replies.
