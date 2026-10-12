# Change settings

Use the [connection configurator](connect.md) to choose your chat apps, bot accounts and replying Agents. Expand **Connection details** to fill in the required information; the configuration updates alongside it.

## Add a chat or account

- **Another chat:** choose the account, click **Add chat**, enter its chat ID and select the receiving Agent.
- **Another bot:** click **Add another account** and enter that account's own settings.
- **Another Agent:** click **Add Agent**, choose dot or Grok and assign the chats it should answer.

Find chat and user IDs using the [channel guides](channels/index.md). For a first WeCom setup, [find the chat ID](channels/wecom.md) before returning to complete the form.

## Choose who can use it

Under **Allowed user IDs**, enter the people who may chat with the bot. Separate multiple IDs with commas.

To connect a topic or thread, enter its thread ID. Leaving it blank receives messages in the main chat only; it does not include every child thread. Add each thread you want to connect.

Several chats can use the same Agent. Each reply still returns to its original chat.

## Set the service address and passwords

Enter your Relanox service address under **Public HTTPS address**, such as `https://relay.example.com`. Both dot and Grok must be able to reach it. If you do not have an address yet, follow [Deployment and backups](operations.md).

The configurator generates an MCP password for each Agent; you can edit it. Copy it from **Setup guide** and set the server environment variables as instructed. Save the passwords before closing or reloading the configurator.

## Apply your changes

1. Download `relanox.json`, keeping the account settings and passwords you already use.
2. Follow **Setup guide** to update the server configuration and credentials, then restart Relanox.
3. Send a message from an allowed account in the newly connected chat and confirm the reply arrives.

After changing an Agent password, follow [Connect an Agent](agents.md) to reconnect. For manual database or port settings, see [Configuration reference](reference/configuration.md).
