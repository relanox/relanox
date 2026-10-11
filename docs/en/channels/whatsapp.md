# WhatsApp Business

Answer customers through a WhatsApp Business Cloud API phone number.

## Prepare your account

Create a Meta app with WhatsApp Business Platform access and register a business phone number. Record the phone number ID and Business Account ID. Obtain an access token with `whatsapp_business_messaging` and access to that phone/business. Save the app secret and choose a verification token.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **WhatsApp**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field  | What to enter                                               |
| ------------------- | ----------------------------------------------------------- |
| Phone number ID     | The phone number id obtained during account preparation     |
| Business account ID | The business account id obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#whatsapp).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use the incoming message’s `from` value for both **Allowed user IDs** and **Chat ID**, for example `15551234567`. Copy the exact digits from the business message event. Use the platform’s phone number ID in `phoneNumberId`, rather than the visible phone number.

## Enable the connection

Start Relanox, then set the WhatsApp webhook callback to `https://relay.example.com/channels/whatsapp-main/webhook` with your `WHATSAPP_VERIFY_TOKEN`. Subscribe the app to the Business Account’s `messages` events.

## Send your first message

From an allowed customer number, send “Hello” to the business number. The customer’s message opens a 24-hour service window for text and media replies. Send a fresh message if a delayed answer reaches an expired window.

## Images and files

Send images, audio, videos or documents, with captions where available. Replies can include JPEG/PNG images up to 5 MB, supported audio and MP4/3GPP videos up to 16 MB, and text/PDF/Office documents up to 100 MB; your relay limit also applies. Prepare mono Opus OGG audio and H.264/AAC video when using those formats.

## Troubleshooting

If callback verification fails, match the verification token exactly. If messages are missing, check the `messages` subscription, Business Account ID and phone number ID. For send errors, check token permissions, the app’s API version and whether the customer has sent a message within the last 24 hours.
