# IRC

Use a dedicated IRC nickname to answer text in channels and private messages.

## Prepare your account

Choose a TLS IRC server with authenticated account tags and register the relay’s nickname/account. Save its SASL password as `IRC_SASL_PASSWORD`. Obtain permission to join and speak in the selected channels. If the network needs a separate server password, add `password: {"env":"IRC_SERVER_PASSWORD"}`.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "irc-main",
      "config": {
        "server": "irc.example.com",
        "port": 6697,
        "tls": true,
        "nick": "relanox",
        "sasl": {
          "username": "relanox",
          "password": {
            "env": "IRC_SASL_PASSWORD"
          }
        }
      },
      "channel": "irc",
      "allowedSenders": ["account:alice"]
    }
  ],
  "bindings": [
    {
      "accountId": "irc-main",
      "chatId": "#support",
      "endpointId": "my-agent"
    }
  ]
}
```

Use `account:<account-name>` for allowed senders: this is the user’s authenticated network account, available in account-tagged messages or the network’s account information. Bind the exact configured channel name as `chatId`. Private bindings use `dm:<folded-nick>` with IRC’s RFC1459 nickname normalization (lowercase plus `[]\^` normalized to `{}|~`). For example, Alice becomes `dm:alice`.

## Enable the connection

Fill in the server hostname, TLS port and nickname. Relanox signs in and automatically joins the channels in this account’s conversation bindings; no separate channel list is needed. Keep the process connected to receive new messages.

## Send your first message

Sign in to your own IRC account and send “Hello” in the bound channel or privately to the relay nickname. Answers appear as ordinary text lines; long answers are split into several lines.

## Images and files

Use IRC for text questions. To ask about an image or file, choose a channel with attachments, such as Telegram, Discord or Matrix, from the [channel guides](../configuration.md).

## Troubleshooting

If a message is filtered, confirm that your IRC client is logged into its network account and the server sends account tags. For networks using nicknames, an administrator can explicitly enable `allowNickFallback:true` and allow `nick:<folded-nick>`; use this only when nickname ownership is acceptable for your access policy. Check SASL credentials and channel access if the relay cannot join.
