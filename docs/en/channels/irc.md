# IRC

Use a dedicated IRC nickname to answer text in channels and private messages.

## Prepare your account

Choose a TLS IRC server with authenticated account tags and register the relay’s nickname/account. Save its SASL password as `IRC_SASL_PASSWORD`. Obtain permission to join and speak in the selected channels. If the network needs a separate server password, fill in the server password variable name.

## Fill in the configurator

Open the [connection configurator](../configuration.md), select **IRC**, and enter the account details and secret environment variable names obtained above. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field                 | What to enter                      |
| ---------------------------------- | ---------------------------------- |
| IRC server hostname                | Replace example: `irc.example.com` |
| TLS port                           | Initial value: `6697`              |
| Bot nickname                       | Replace example: `relanox`         |
| SASL account name                  | Replace example: `relanox`         |
| SASL password environment variable | Variable name: `IRC_SASL_PASSWORD` |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#irc).

Use `account:<account-name>` for allowed senders: this is the user’s authenticated network account, available in account-tagged messages or the network’s account information. Bind the exact configured channel name as **Chat ID**. Private bindings use `dm:<folded-nick>` with IRC’s RFC1459 nickname normalization (lowercase plus `[]\^` normalized to `{}|~`). For example, Alice becomes `dm:alice`.

## Enable the connection

Fill in the server hostname, TLS port and nickname. Relanox signs in and automatically joins the channels in this account’s conversation bindings; no separate channel list is needed. Keep the process connected to receive new messages.

## Send your first message

Sign in to your own IRC account and send “Hello” in the bound channel or privately to the relay nickname. Answers appear as ordinary text lines; long answers are split into several lines.

## Images and files

Use IRC for text questions. To ask about an image or file, choose a channel with attachments, such as Telegram, Discord or Matrix, from the [channel guides](../configuration.md).

## Troubleshooting

If a message is filtered, confirm that your IRC client is logged into its network account and the server sends account tags. Check SASL credentials and channel access if the relay cannot join.
