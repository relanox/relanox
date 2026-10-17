# Connect an Agent

Use the [connection configurator](connect.md) to connect an existing dot, Grok Bot or Muse to your conversations. Prepare your public HTTPS address, choose the Agent, and select it for each chat that should receive its replies.

Download the configuration and open **Your setup guide**. Keep the guide open while setting up: its addresses and passwords belong to your selected Agents. Save the generated passwords securely before closing or reloading the page.

## Connect Grok

Use the Grok Bot desktop app, signed in with your paid Cursor account. Cursor Pro includes Grok Bot usage; the ordinary Grok chat website is a different interface.

1. In the Relanox configurator, add a Grok Agent and select it for your chat.
2. In the Grok Bot conversation that should answer, ask: “Create a routine triggered only by a webhook. Process the incoming user message using the instructions provided by the Relanox MCP connection. Do not add a schedule.”
3. Click the Bot's name, then open the routine under **Details → Routines**. Its **Webhook** section contains **POST to**, **key**, and **header**. Use **POST to** for the Routine URL. For the Routine Authorization environment variable, use `Bearer <key>`: if you copy **header**, remove the leading `Authorization:` label.
4. Open the generated setup guide, save its MCP password, set the listed environment variables, and start Relanox at your public HTTPS address. See [Quick start](getting-started.md).
5. In the same Cursor account's dashboard, open **Plugins & MCPs → Add → Custom MCP**. Enter a name, keep **URL** selected, and paste the complete generated Grok MCP address into **Server URL**. Leave **HTTP headers**, **Client ID**, and **Client Secret** empty, then choose **Add MCP**.
6. In Grok Bot, open **Connect apps → Your plugins** and confirm the connection is ready. The connection is shared by the account; use the Bot whose routine you created.
7. Send a short message from an allowed sender in the bound chat. Confirm the reply arrives in that chat, not just in the Grok Bot conversation.

Grok needs both the Routine settings and the MCP connection. Protect the Routine URL, key and full MCP address.

## Connect dot

1. In the configurator, add a dot Agent and select it for your chat.
2. Open the generated setup guide. Save its authorization password and set the listed environment variable to that value. [Quick start](getting-started.md) covers starting Relanox with your downloaded configuration.
3. In ChatGPT, open **Plugins → Add → Add custom MCP server**. Enter a name such as `Relanox`, paste the dot MCP address from the guide into **Server URL**, and keep **OAuth** selected for authentication. Relanox must be reachable at that address.
4. Review the notice and choose **Create as plugin**. When the Relanox authorization page opens, enter the generated password and allow access.
5. In your dot conversation, enable the Relanox plugin and ask: “Subscribe to incoming messages from Relanox. For each event, read its message and reply to the original chat using the Relanox tools.” Allow dot to set up the subscription.
6. Send a short message from an allowed sender in the selected chat and check that the answer arrives there. A successful OAuth login or accepted notification alone does not confirm that dot has replied.

Ask dot to check its Relanox connection. It can list the available chats and check whether it is subscribed to incoming messages. If you change the authorization password, restart Relanox and reconnect dot. If dot stops receiving new messages, check the plugin connection and Relanox message status.

After upgrading from a version that saved dot subscriptions without endpoint ownership, ask dot to refresh or recreate its `relanox.message_available` subscription. Until then, Relanox reports no active subscription and retries pending notifications. Changing an endpoint's configuration also requires a new subscription; rotating the password value under the same environment variable name does not.

## Connect Muse {#connect-muse}

Muse runs in its own cloud VM. Relanox sends incoming notifications through a paired Muse device connection; Muse uses your Relanox MCP connector to read attachments and reply to the original chat.

1. Obtain a personal [Muse Gadget SDK token](https://gadgets.muse.ai/settings/sdk-tokens), then follow the [official Linux device pairing guide](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux). In the phone app, enable **Settings → Devices → Developer mode** and add the device shown by the pairing process.
2. After pairing, stop and disable the SDK daemon before Relanox uses that device's credentials. For a systemd installation, run `sudo systemctl disable --now musegadget`. Relanox does not need the daemon's local command service.
3. Copy that pairing's `identity.json`, `pairing.json` and `sdk_token` into a private, persistent directory owned by the Relanox service user. The service must be able to update `pairing.json` when tokens rotate. Use a separate pairing and directory for each independently running Relanox deployment; never run another SDK daemon or client against the same credentials concurrently.
4. In the configurator, add a Muse Agent and select it for the chat. Set the generated credentials-directory environment variable, normally `RELANOX_AGENT_1_CREDENTIALS_DIRECTORY`, to the absolute path of that directory. Save and set the separate generated MCP token. For containers, mount the directory writable and use its path inside the container.
5. Start Relanox at your public HTTPS address. In Muse, ask it to create a custom connector using the complete generated Muse MCP URL and verify that it can call `relanox_status`. The [Muse connector guidelines](https://muse.ai/platform/docs) describe the platform's connector model.
6. Send a short message from an allowed user in a bound chat. Confirm the answer arrives there. A notification appearing in Muse alone does not send a reply to the original conversation.

The adapter uses text notifications containing the source channel, request ID and attachment metadata. Muse reads and sends media through the MCP tools; native voice/chat attachment uploading and automatic forwarding of Muse's own chat responses are unavailable. The default target is the account's default VM and main chat. Manual settings can select `vmId` and `sessionId`; see the [Muse configuration reference](reference/agents.md#connect-muse).

Back up the credential directory separately from the Relanox database. Local SDK-boundary and MCP tests cover this adapter; a live Muse account roundtrip has not been verified.

## Check the connection

You do not need to copy a separate reply prompt into the Bot or Routine.

With any of the three Agents, ask it to check Relanox's available chats. It can then send to an authorized chat when that platform's permissions and sending conditions allow it, even before Relanox receives a message there. Some platforms require a recent incoming message or an existing conversation; see [Destination availability](reference/channels.md#destinations). A queued message is saved for sending; check its delivery before requesting another copy.

If no reply arrives, first check that the chat uses the intended Agent and that the sender is allowed. Compare the connection address and password with the generated guide. For Grok, also compare the Routine URL and complete Authorization value; for dot, check the plugin connection and authorization. For Muse, check the paired credential directory, exclusive access to it, and the custom connector. Use [message status and recovery](reference/core.md) to find where a message stopped.

If the Agent cannot send messages after an upgrade, refresh or reconnect its MCP connection. If that does not help, create a connection with a new name. For Grok, select the new connection in the Routine, then send a test message.

For manual JSON setup, authentication details and MCP tool contracts, see [Agent configuration and protocol](reference/agents.md). For attachments, see [Send pictures and files](media.md).
