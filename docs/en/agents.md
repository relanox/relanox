# Connect an Agent

Use the [connection configurator](connect.md) to connect an existing dot or Grok Bot to your conversations. Prepare your public HTTPS address, choose the Agent, and select it for each chat that should receive its replies.

Download the configuration and open **Your setup guide**. Keep the guide open while setting up: its addresses and passwords belong to your selected Agents. Save the generated passwords securely before closing or reloading the page.

## Connect Grok

Use the Grok Bot desktop app, signed in with your paid Cursor account. Cursor Pro includes Grok Bot usage; the ordinary Grok chat website is a different interface.

1. In the Relanox configurator, add a Grok Agent and select it for your chat.
2. In the Grok Bot conversation that should answer, ask: “Create a routine triggered only by a webhook. Process the incoming user message using the instructions provided by the Relanox MCP connection. Do not add a schedule.”
3. Click the Bot's name, then open the routine under **Details → Routines**. Its **Webhook** section contains **POST to**, **key**, and **header**. Use **POST to** for the Routine URL. For the Routine Authorization environment variable, use `Bearer <key>`: if you copy **header**, remove the leading `Authorization:` label.
4. Open the generated setup guide, save its MCP password, set the listed environment variables, and start Relanox at your public HTTPS address. See [Quick start](getting-started.md).
5. In the same Cursor account's dashboard, open **Plugins & MCPs → Add → Custom MCP**. Enter a name, keep **URL** selected, and paste the complete generated Grok MCP address into **Server URL**. Leave **HTTP headers**, **Client ID**, and **Client Secret** empty, then choose **Add MCP**.
6. In Grok Bot, open **Connect apps → Your plugins** and confirm the connection is ready. It should expose `relanox_status`, `relanox_send_message`, `relanox_read_media` and `relanox_create_upload`. The connection is shared by the account; use the Bot whose routine you created.
7. Send a short message from an allowed sender in the bound chat. Confirm the reply arrives in that chat, not just in the Grok Bot conversation.

There is no single “MCP callback” field: Relanox calls the Routine webhook to wake the Bot; the Bot calls Relanox through the MCP connection to reply. Protect the Routine URL, key and full MCP address.

## Connect dot

1. In the configurator, add a dot Agent and select it for your chat.
2. Open the generated setup guide. Save its authorization password and set the listed environment variable to that value. [Quick start](getting-started.md) covers starting Relanox with your downloaded configuration.
3. In ChatGPT, open **Plugins → Add → Add custom MCP server**. Enter a name such as `Relanox`, paste the dot MCP address from the guide into **Server URL**, and keep **OAuth** selected for authentication. Relanox must be reachable at that address.
4. Review the notice and choose **Create as plugin**. When the Relanox authorization page opens, enter the generated password and allow access.
5. In your dot conversation, enable the Relanox plugin and ask: “Subscribe to incoming messages from Relanox. For each event, read its message and reply to the original chat using the Relanox tools.” Allow dot to set up the subscription.
6. Send a short message from an allowed sender in the selected chat and check that the answer arrives there. A successful OAuth login or accepted notification alone does not confirm that dot has replied.

The initial connection check uses `relanox_status` without arguments. It lists the chats dot may use and its active subscription count, even before a message arrives. Each event supplies its source chat and attachment IDs automatically. If you change the authorization password, restart Relanox and reconnect dot. If dot stops receiving new messages, check the plugin connection and Relanox message status.

## Check the connection

You do not need to copy a separate reply prompt into the Bot or Routine.

With either Agent, ask it to check Relanox's available chats. It can then send to an authorized chat when that platform's permissions and sending conditions allow it, even before Relanox receives a message there. Some platforms require a recent customer message, callback or conversation metadata; see [Destination availability](reference/channels.md#destinations). A queued message is saved for sending; check its delivery before requesting another copy.

If no reply arrives, first check that the chat uses the intended Agent and that the sender is allowed. Compare the connection address and password with the generated guide. For Grok, also compare the Routine URL and complete Authorization value; for dot, check the plugin connection and authorization. Use [message status and recovery](reference/core.md) to find where a message stopped.

If the Agent still offers `replyTo` or lacks current tools after an upgrade, refresh or reconnect its MCP connection. A live Grok check retained old tool parameters after changing the server URL; creating a connection with a new name and selecting it for the Routine loaded the current definitions. If refreshing does not help, use a new connection and update the test Routine to use it before sending another message. Do not reuse old message IDs as channel IDs.

For manual JSON setup, authentication details and MCP tool contracts, see [Agent configuration and protocol](reference/agents.md). For attachments, see [Send pictures and files](media.md).
