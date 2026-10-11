# Matrix

Use a dedicated Matrix account in unencrypted rooms and threads.

## Prepare your account

Create a dedicated account/device on your homeserver and obtain its access token. Save it as `MATRIX_ACCESS_TOKEN`; Invite the account into each room and let it join. Give it permission to send messages and upload files.

## Fill in the configurator

Open the [connection configurator](../configuration.md), select **Matrix**, and enter the account details and secret environment variable names obtained above. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field                | What to enter                                 |
| --------------------------------- | --------------------------------------------- |
| Homeserver URL                    | Replace example: `https://matrix.example.com` |
| Access token environment variable | Variable name: `MATRIX_ACCESS_TOKEN`          |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#matrix).

Use exact Matrix user IDs such as `@alice:example.com` for allowed senders. Copy the internal room ID, such as `!support:example.com`, from room information or a room event for **Chat ID**. A room alias like `#support:example.com` is different from the room ID. For a thread, use the original `m.thread` root event ID as **Thread ID**.

## Enable the connection

Start Relanox to begin receiving messages from the homeserver automatically. Keep the account logged in on the configured device and keep Relanox running. Use an HTTPS homeserver address.

## Send your first message

Send “Hello” from an allowed account in the bound unencrypted room. For a thread binding, reply inside that thread. The dedicated account sends the agent’s answer into the same room or thread.

## Images and files

Attach images, audio, videos or files to your room message. Generated attachments are uploaded to the homeserver and appear as native room messages. Keep them within both your homeserver upload limit and the Relanox media limit.

## Troubleshooting

If no messages arrive, check that the account joined the room, the room is unencrypted and the token is valid. If a thread gets no answer, compare the root event ID. If Relanox reports a history gap after an outage, inspect the missing conversation and resend the questions you still want answered before recovering the connection.
