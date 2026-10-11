# Signal with signal-cli

Use a dedicated Signal account through a separately managed signal-cli daemon.

## Prepare your account

Install signal-cli, register or link the Signal account, and start its HTTP JSON-RPC/SSE daemon. Record the account number. Back up signal-cli’s account/session data alongside your Relanox database. For remote access, place the daemon behind an authenticated HTTPS proxy; save the complete Authorization header value as `SIGNAL_BRIDGE_AUTHORIZATION`.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Signal**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field              | What to enter                                                           |
| ------------------------------- | ----------------------------------------------------------------------- |
| Signal bridge URL               | The signal bridge url obtained during account preparation               |
| Registered account phone number | The registered account phone number obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#signal).

To discover a sender, send a test message and have the daemon administrator inspect its `/api/v1/events?account=<account>` event stream. Use the received envelope’s `sourceUuid` as the allowed sender when available; otherwise use its number/source identifier. Bind a direct conversation as `direct:<sender>` and a group as `group:<groupId>`. Get the group ID from the daemon’s group information or received envelope.

## Enable the connection

Set **Signal bridge URL** to the daemon/proxy’s base URL and **Registered account phone number** to its registered number. Relanox connects automatically when started.

## Send your first message

From an allowed Signal contact, send “Hello” to the dedicated account or a bound group it has joined. Leave both signal-cli and Relanox running so incoming questions can be received.

## Images and files

Send images, audio, videos or files normally. Ensure signal-cli downloads incoming attachments so Relanox can retrieve them. Generated attachments are sent through the same dedicated Signal account. Respect Signal’s limits and the Relanox media limit.

## Troubleshooting

If messages are missing, check the daemon’s registered account, event stream and proxy authorization. If attachments fail, verify that signal-cli has downloaded and retained them. After a daemon restart or long disconnection, resend any questions that did not receive answers.
