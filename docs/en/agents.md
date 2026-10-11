# Connect an Agent

Use the [connection configurator](connect.md) to connect an existing dot or Grok Bot to your conversations. Prepare your public HTTPS address, choose the Agent, and select it for each chat that should receive its replies.

Download the configuration and open **Your setup guide**. Keep the guide open while setting up: its addresses and passwords belong to your selected Agents. Save the generated passwords securely before closing or reloading the page.

## Connect Grok

1. In the configurator, add a Grok Agent and select it for your chat.
2. In Grok, choose the Bot that should answer and create a Routine with a webhook trigger. Copy its complete webhook URL and Authorization value.
3. Open the generated setup guide. Set the environment variables it lists: use the generated MCP password and the Routine values from Grok. Keep the Authorization value exactly as supplied, including its prefix. [Quick start](getting-started.md) explains how to set variables and start Relanox.
4. Start Relanox with the downloaded configuration and make its public HTTPS address reachable. Follow [Deployment and daily use](operations.md) for HTTPS setup.
5. Copy the full Grok MCP address from the generated guide into the Bot's MCP connection. Select no additional authentication. Set the Routine to use this Bot.
6. Send a short message from an allowed sender in the selected chat and check that the answer arrives there.

Protect the Routine URL, Authorization value and MCP address: they may contain credentials. Copy the generated MCP address as a whole rather than rebuilding it yourself.

## Connect dot

1. In the configurator, add a dot Agent and select it for your chat.
2. Open the generated setup guide. Save its authorization password and set the listed environment variable to that value. [Quick start](getting-started.md) covers starting Relanox with your downloaded configuration.
3. In ChatGPT, open **Plugins → Add → Add custom MCP server**. Enter a name such as `Relanox`, paste the dot MCP address from the guide into **Server URL**, and keep **OAuth** selected for authentication. Relanox must be reachable at that address.
4. Review the notice and choose **Create as plugin**. When the Relanox authorization page opens, enter the generated password and allow access.
5. Send a short message from an allowed sender in the selected chat and check that the answer arrives there.

If you change the authorization password, restart Relanox and reconnect dot. If dot stops receiving new messages, check the plugin connection and Relanox message status.

## Check the connection

You do not need to copy a separate reply prompt into the Bot or Routine. After updating Relanox, refresh or reconnect the Agent's MCP connection, then send another message to check the reply.

If no reply arrives, first check that the chat uses the intended Agent and that the sender is allowed. Compare the connection address and password with the generated guide. For Grok, also compare the Routine URL and complete Authorization value; for dot, check the plugin connection and authorization. Use [message status and recovery](reference/core.md) to find where a message stopped.

For manual JSON setup, authentication details and MCP tool contracts, see [Agent configuration and protocol](reference/agents.md). For attachments, see [Send pictures and files](media.md).
