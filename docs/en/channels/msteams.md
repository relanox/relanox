# Microsoft Teams

Talk to your agent through an installed Teams bot in personal chats, groups or channels.

## Prepare your account

Register a Microsoft application and Azure Bot, enable its Teams channel, and install the Teams app for the intended users/teams. Record the application ID, bot activity ID and tenant ID; save the app secret as `TEAMS_APP_SECRET`. Ask your administrator for the exact trusted Bot Connector service origins for your region.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Microsoft Teams**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field                        | What to enter                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Application ID                            | The application id obtained during account preparation                            |
| Bot ID                                    | The bot id obtained during account preparation                                    |
| Tenant ID                                 | The tenant id obtained during account preparation                                 |
| Trusted service origins (comma separated) | The trusted service origins (comma separated) obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#msteams).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Read IDs from a Teams message activity: `from.id` is the allowed sender, `conversation.id` is the binding chat ID, and `recipient.id` is the configured bot ID. Use the activity’s tenant ID for `tenantId`. A binding for a reply chain uses `replyToId` as **Thread ID** when present.

## Enable the connection

Set the bot messaging endpoint to `https://relay.example.com/channels/msteams-main/activities`, then start Relanox. `trustedServiceOrigins` entries are exact HTTPS origins, such as `https://smba.trafficmanager.net`, without a path or trailing slash; use the values for your deployment.

Sending to a bound conversation also needs its Bot Connector service address and conversation metadata. Relanox records these from authenticated `message`, `conversationUpdate` or `installationUpdate` activities whose sender is allowed and whose bot and tenant match the account. An installation or conversation activity can therefore make the destination available before its first message. A chat ID alone is insufficient; the service address must pass `trustedServiceOrigins` checks.

## Send your first message

Open the installed bot’s personal chat and send “Hello”. For a group/channel binding, add the bot and mention it in that conversation. Use the tenant and user you configured.

When the Agent specifies `reply.requestId`, the answer quotes that incoming message using Teams' native quoted reply. The answer stays in its bound thread; replying to a root-conversation message uses that selected message's reply chain. Text, cards and attachments share the same reference. Sending without `reply` omits the quote and stays in the bound conversation or thread.

## Images and files

Send inline images or personal-chat files with your question. For file replies in personal chats, set `supportsFiles:true` in the Teams app manifest and configure exact `trustedUploadOrigins` for your tenant’s OneDrive upload service. When the bot asks for file consent, accept to receive the file. Personal-chat images above 15,000 bytes also arrive as file cards. Group/channel image replies above that size use the public media address described in [Media](../media.md).

## Troubleshooting

For authentication failures, compare the application, bot and tenant IDs and verify the registration’s OAuth token URL. For service-origin errors, ask the administrator to confirm the activity’s service origin before adding it. If a file is waiting, open the personal-chat consent card; for a refused upload, check `trustedUploadOrigins` and the app’s file setting.
