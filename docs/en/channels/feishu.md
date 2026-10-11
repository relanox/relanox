# Feishu / Lark

Connect an internal Feishu or Lark application bot to your agent.

## Prepare your account

Create an internal application, enable its bot capability and grant message reception, sending and resource access permissions. Record the app ID, tenant key and bot open ID. Save the app secret, event verification token and encryption key in the environment variables shown below. For Lark, change `domain` to `"lark"`.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "feishu-main",
      "channel": "feishu",
      "allowedSenders": ["ou_example_user"],
      "config": {
        "appId": "cli_example",
        "appSecret": {
          "env": "FEISHU_APP_SECRET"
        },
        "verificationToken": {
          "env": "FEISHU_VERIFICATION_TOKEN"
        },
        "encryptKey": {
          "env": "FEISHU_ENCRYPT_KEY"
        },
        "tenantKey": "example-tenant",
        "botOpenId": "ou_example_bot",
        "domain": "feishu"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "feishu-main",
      "chatId": "oc_example_chat",
      "endpointId": "my-agent"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use the message event’s sender `open_id` for `allowedSenders` and `message.chat_id` for `chatId`. The event header supplies `tenant_key`; the bot identity can be obtained from the bot information API. A thread binding uses `message.thread_id`, or `root_id` when that is the supplied thread reference.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Configure event subscription v2.0 with `https://relay.example.com/channels/feishu-main/events`, subscribe to `im.message.receive_v1`, and configure the same verification token and encryption key. Start Relanox before verifying the callback, then publish the app changes and make the bot available to your users.

## Send your first message

Open a conversation with the bot, or add it to the bound group and mention it with “Hello”. Use a user inside the app’s availability range and your sender allowlist.

## Images and files

Send images, audio, videos, files or rich posts with your question. Grant resource download/upload permissions such as `im:resource` or the applicable upload scope. Replies can contain images up to 10 MiB and other uploads up to 30 MiB, within the relay limit. Generated audio needs Opus/Ogg and a duration; video needs MP4 and a duration.

## Troubleshooting

If callback verification fails, compare the token and encryption key on both sides. If some users cannot talk to the bot, check the published app’s availability range. For media failures, check resource permissions and reinstall/publish the permission changes as required by your organization.
