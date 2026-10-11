# Microsoft Teams

Talk to your agent through an installed Teams bot in personal chats, groups or channels.

## Prepare your account

Register a Microsoft application and Azure Bot, enable its Teams channel, and install the Teams app for the intended users/teams. Record the application ID, bot activity ID and tenant ID; save the app secret as `TEAMS_APP_SECRET`. Ask your administrator for the exact trusted Bot Connector service origins for your cloud/region. For a single-tenant or sovereign bot, configure the appropriate `tokenUrl` for that registration.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "msteams-main",
      "config": {
        "appId": "microsoft_application_id",
        "botId": "28:bot_activity_recipient_id",
        "tenantId": "allowed_teams_tenant_id",
        "appSecret": {
          "env": "TEAMS_APP_SECRET"
        },
        "trustedServiceOrigins": ["https://smba.trafficmanager.net"]
      },
      "channel": "msteams",
      "allowedSenders": ["29:teams-user-id"]
    }
  ],
  "bindings": [
    {
      "accountId": "msteams-main",
      "chatId": "teams-conversation-id",
      "endpointId": "my-agent"
    }
  ]
}
```

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Read IDs from a Teams message activity: `from.id` is the allowed sender, `conversation.id` is the binding chat ID, and `recipient.id` is the configured bot ID. Use the activity’s tenant ID for `tenantId`. A binding for a reply chain uses `replyToId` as `threadId` when present.

Bindings match the exact chat and thread IDs. Include `threadId` when your test message has one; omitting it selects messages without a thread ID.

## Enable the connection

Set the bot messaging endpoint to `https://relay.example.com/channels/msteams-main/activities`, then start Relanox. `trustedServiceOrigins` entries are exact HTTPS origins, such as `https://smba.trafficmanager.net`, without a path or trailing slash; use the values for your deployment.

## Send your first message

Open the installed bot’s personal chat and send “Hello”. For a group/channel binding, add the bot and mention it in that conversation. Use the tenant and user you configured.

## Images and files

Send inline images or personal-chat files with your question. For file replies in personal chats, set `supportsFiles:true` in the Teams app manifest and configure exact `trustedUploadOrigins` for your tenant’s OneDrive upload service. When the bot asks for file consent, accept to receive the file. Personal-chat images above 15,000 bytes also arrive as file cards. Group/channel image replies above that size use the public media address described in [Media](../media.md).

## Troubleshooting

For authentication failures, compare the application, bot and tenant IDs and verify the registration’s OAuth token URL. For service-origin errors, ask the administrator to confirm the activity’s service origin before adding it. If a file is waiting, open the personal-chat consent card; for a refused upload, check `trustedUploadOrigins` and the app’s file setting.
