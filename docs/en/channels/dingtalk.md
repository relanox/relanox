# DingTalk application robot

Connect a DingTalk application robot for private questions and group conversations.

## Prepare your account

Create an application robot, record its client ID and robot code, and save its app secret as `DINGTALK_APP_SECRET`. Enable Stream reception. Grant the robot the independent single-user/group message API permissions and media download/upload permissions. Add it to the intended groups and make it available to the intended staff.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "dingtalk-main",
      "channel": "dingtalk",
      "allowedSenders": ["$:LWCP_v1:opaque-platform-sender-id"],
      "config": {
        "clientId": "application-client-id",
        "clientSecret": {
          "env": "DINGTALK_APP_SECRET"
        },
        "robotCode": "application-robot-code",
        "apiBase": "https://api.dingtalk.com"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "dingtalk-main",
      "chatId": "staff-user-id",
      "endpointId": "my-agent"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

The sender allowlist uses the callback’s opaque `senderId`, including any prefix. A direct-chat `chatId` uses `senderStaffId`; a group `chatId` uses `conversationId` (the open conversation ID). Read these values from an application-robot message event. The sender and direct-chat identifiers serve different purposes, so copy each exact field.

## Enable the connection

Start Relanox after saving the account configuration. It opens the Stream connection automatically using the application credentials. Keep outbound HTTPS and WebSocket access available.

## Send your first message

Send “Hello” to the application robot from an allowed staff member. In a group, mention the robot; the group event must indicate that the bot was addressed.

## Images and files

Send pictures, audio, videos, files or rich-text messages. Replies can include JPEG/PNG/GIF/BMP images, MP4 video and files up to 20 MiB, and AMR audio up to 2 MiB, within the relay limit. Generated audio needs a duration; video also needs an image preview and a duration. File replies use XLSX, PDF, ZIP, RAR, DOC or DOCX formats.

## Troubleshooting

If the robot connects but sends no reply, check the independent message API permissions and the staff/group availability. If private questions are filtered, compare `senderId` with the allowlist and `senderStaffId` with the binding. For group failures, check the robot code and group membership.
