# Matrix

Use a dedicated Matrix account in unencrypted rooms and threads.

## Prepare your account

Create a dedicated account/device on your homeserver and obtain its access token. Save it as `MATRIX_ACCESS_TOKEN` and record its full user ID. Invite the account into each room and let it join. Give it permission to send messages and upload files.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "matrix-main",
      "config": {
        "homeserver": "https://matrix.example.com",
        "userId": "@relay:example.com",
        "accessToken": {
          "env": "MATRIX_ACCESS_TOKEN"
        }
      },
      "channel": "matrix",
      "allowedSenders": ["@alice:example.com"]
    }
  ],
  "bindings": [
    {
      "accountId": "matrix-main",
      "chatId": "!support:example.com",
      "endpointId": "my-agent"
    }
  ]
}
```

Use exact Matrix user IDs such as `@alice:example.com` for allowed senders. Copy the internal room ID, such as `!support:example.com`, from room information or a room event for `chatId`. A room alias like `#support:example.com` is different from the room ID. For a thread, use the original `m.thread` root event ID as `threadId`.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Start Relanox to begin receiving messages from the homeserver automatically. Keep the account logged in on the configured device and keep Relanox running. Use an HTTPS homeserver address.

## Send your first message

Send “Hello” from an allowed account in the bound unencrypted room. For a thread binding, reply inside that thread. The dedicated account sends the agent’s answer into the same room or thread.

## Images and files

Attach images, audio, videos or files to your room message. Generated attachments are uploaded to the homeserver and appear as native room messages. Keep them within both your homeserver upload limit and the Relanox media limit.

## Troubleshooting

If no messages arrive, check that the account joined the room, the room is unencrypted and the token is valid. If a thread gets no answer, compare the root event ID. If Relanox reports a history gap after an outage, inspect the missing conversation and resend the questions you still want answered before recovering the connection.
