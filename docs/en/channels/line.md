# LINE

Connect a LINE Official Account to answer private, group and room messages.

## Prepare your account

Create an Official Account with a Messaging API channel. Save its channel secret and access token in the environment variables below. Add the Official Account as a friend, or invite it into the intended group/room. Check that your plan has enough push-message quota.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **LINE**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#line).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use event `source.userId` in **Allowed user IDs**. For a private conversation use that user ID as **Chat ID**; for a group use `source.groupId`, and for a room use `source.roomId`.

## Enable the connection

Enable Webhooks and set the URL to `https://relay.example.com/channels/line-main/webhook`. Start Relanox, then use the platform’s webhook verification. Enable webhook redelivery if you want LINE to retry failed event delivery.

## Send your first message

Send “Hello” from an allowed user to the Official Account or into the bound group/room. The reply is sent by the Official Account to that conversation.

When the Agent supplies `reply.requestId`, text replies quote that incoming message if LINE supplied its native quote token. Quoted text shows Markdown links as their label followed by the destination URL. Without `reply`, messages are sent normally. LINE permits quoting in text messages; image, audio, video and Flex replies do not display a quote. An incoming message ID cannot replace a missing quote token.

## Images and files

Send images, audio, videos or files with your question. Image, audio and video replies need the public address; follow [Media](../media.md) to expose it over HTTPS. Use JPEG/PNG images up to 10 MB. Images larger than 1 MB (1,000,000 bytes) and every MP4 video require a JPEG/PNG preview up to 1 MB. Generated audio uses MP3/M4A with a duration. Audio/video can be up to 200 MB, within your relay limit.

## Troubleshooting

If webhook verification fails, check that the channel secret and access token belong to the same Official Account. For missing group messages, enable group access for the Official Account and confirm its membership. If text works but media replies fail, verify the HTTPS media address, preview image and duration; check push quota for all replies.
