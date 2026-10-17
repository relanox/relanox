# Matrix

Use a dedicated Matrix account in unencrypted rooms and threads.

## Prepare your account

Create a dedicated account/device on your homeserver and obtain its access token. Save it as `MATRIX_ACCESS_TOKEN`; Invite the account into each room and let it join. Give it permission to send messages and upload files.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Matrix**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                          |
| ------------------ | ------------------------------------------------------ |
| Homeserver URL     | The homeserver url obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#matrix).

Use exact Matrix user IDs such as `@alice:example.com` for allowed senders. Copy the internal room ID, such as `!support:example.com`, from room information or a room event for **Chat ID**. A room alias like `#support:example.com` is different from the room ID. For a thread, use the original `m.thread` root event ID as **Thread ID**.

## Enable the connection

Start Relanox to begin receiving messages from the homeserver automatically. Keep the account logged in on the configured device and keep Relanox running. Use an HTTPS homeserver address.

The official [Matrix JavaScript SDK](https://github.com/matrix-org/matrix-js-sdk) manages synchronization and reconnects. Its in-memory sync cursor can advance before Relanox finishes saving an event or downloading its attachments. A failed download, interrupted process or restart can therefore leave messages unaccepted; resend questions that still need an answer. Messages and deliveries already accepted by Core remain in the configured database and resume after restart. Encrypted rooms and encrypted attachments are unsupported.

## Send your first message

Send “Hello” from an allowed account in the bound unencrypted room. For a thread binding, reply inside that thread. The dedicated account sends the agent’s answer into the same room or thread.

The Agent can quote a specific incoming event with `reply.requestId`, even after later messages arrive. Thread placement and fallback metadata follow the official SDK. Sends without `reply` retain the configured thread destination without selecting an incoming event to quote.

## Images and files

Attach images, audio, videos or files to your room message. Generated attachments are uploaded through the SDK and appear as native room messages. Relanox defaults to 100 MiB for each attachment and for all attachments in one message; configured media limits also bound incoming downloads. Your homeserver decides its upload limit, so this budget does not guarantee that it accepts a 100 MiB file. Oversized uploads are rejected, rate limits defer delivery, and an uncertain message-send result is recorded as unknown rather than retried as a known refusal.

## Troubleshooting

If no messages arrive, check that the account joined the room, the room is unencrypted and the token is valid. If a thread gets no answer, compare the root event ID. After an outage or failed attachment download, inspect the conversation and resend questions that have not reached the Agent.
