# Google Chat

Use a Google Chat HTTP app in spaces and message threads.

## Prepare your account

Enable the Chat API in a Google Cloud project, configure a Chat app and create its service account. Store the complete service-account JSON in `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`. Use app authentication with the `chat.bot` scope. Make the app available under your organization’s policies and add it to the intended spaces.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "googlechat-main",
      "config": {
        "audience": "https://relay.example.com/channels/googlechat-main/webhook",
        "callerEmail": "chat@system.gserviceaccount.com",
        "serviceAccount": {
          "env": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
        }
      },
      "channel": "googlechat",
      "allowedSenders": ["users/123456789"]
    }
  ],
  "bindings": [
    {
      "accountId": "googlechat-main",
      "chatId": "spaces/AAAAExample",
      "endpointId": "my-agent",
      "threadId": "spaces/AAAAExample/threads/BBBBExample"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Read the message event’s sender resource name (`users/<id>`) for `allowedSenders`, space name (`spaces/<id>`) for `chatId`, and the message’s thread name (`spaces/<id>/threads/<id>`) for `threadId`. Copy full resource names. The example binds one exact space/thread pair. When the incoming message contains a thread, its full name must match `threadId`. Add a separate binding for each thread you want to use.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Configure the app’s HTTP endpoint as `https://relay.example.com/channels/googlechat-main/webhook`. Set the app’s authentication audience and the account’s `audience` to that exact URL. Start Relanox before sending app interactions. The default caller email is `chat@system.gserviceaccount.com`.

## Send your first message

Mention the installed app with “Hello” inside the configured space/thread. For a direct conversation, bind the actual space and thread fields from its message event first. Open the same thread to see its answer.

## Images and files

Upload an attachment directly to Chat with your question. For generated media, configure `media.publicBaseUrl` as described in [Media](../media.md). Image replies appear as cards; audio, videos and files appear as named download buttons. The public media address must be reachable by recipients and by Google for image display.

## Troubleshooting

For authentication errors, compare `audience` with the complete endpoint URL, including the account ID and path. For send failures, check the service-account JSON, Chat API and app membership. For missing images/downloads, check the public media URL. Upload the file directly to Chat when you want the agent to read its bytes.
