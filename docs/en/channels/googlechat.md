# Google Chat

Use a Google Chat HTTP app in spaces and message threads.

## Prepare your account

Enable the Chat API in a Google Cloud project, configure a Chat app and create its service account. Store the complete service-account JSON in `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`. Use app authentication with the `chat.bot` scope. Make the app available under your organization’s policies and add it to the intended spaces.

## Fill in the configurator

Open the [connection configurator](../configuration.md), select **Google Chat**, and enter the account details and secret environment variable names obtained above. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field                        | What to enter                                     |
| ----------------------------------------- | ------------------------------------------------- |
| Service account JSON environment variable | Variable name: `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#googlechat).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Read the message event’s sender resource name (`users/<id>`) for **Allowed user IDs**, space name (`spaces/<id>`) for **Chat ID**, and the message’s thread name (`spaces/<id>/threads/<id>`) for **Thread ID**. Copy full resource names. When the incoming message contains a thread, its full name must match **Thread ID**. Add a separate binding for each thread you want to use.

## Enable the connection

In the configurator, set the public address to `https://relay.example.com`. In the Google Chat console, configure the app’s HTTP endpoint as `https://relay.example.com/channels/googlechat-main/webhook` and select **HTTP endpoint URL** as the authentication audience mode. If you rename the account, replace `googlechat-main` in the endpoint path too. Start Relanox before sending app interactions.

## Send your first message

Mention the installed app with “Hello” inside the configured space/thread. For a direct conversation, bind the actual space and thread fields from its message event first. Open the same thread to see its answer.

## Images and files

Upload an attachment directly to Chat with your question. For generated media, configure the public address as described in [Media](../media.md). Image replies appear as cards; audio, videos and files appear as named download buttons. The public media address must be reachable by recipients and by Google for image display.

## Troubleshooting

For authentication errors, check the console’s HTTP endpoint URL audience mode and compare the endpoint with the public address plus `/channels/<account-id>/webhook`. For send failures, check the service-account JSON, Chat API and app membership. For missing images/downloads, check the public media URL. Upload the file directly to Chat when you want the agent to read its bytes.
