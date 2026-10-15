# Feishu / Lark

Connect an internal Feishu or Lark application bot to your agent.

## Prepare your account

Create an internal application, enable its bot capability and grant message reception, sending and resource access permissions. Record the app ID and tenant key; save the app secret, event verification token and encryption key in the environment variables listed in the generated setup guide. For Lark, select lark in **Platform domain**.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **Feishu / Lark**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field               | What to enter                                          |
| -------------------------------- | ------------------------------------------------------ |
| Application ID                   | The application id obtained during account preparation |
| Tenant key                       | The tenant key obtained during account preparation     |
| Platform domain (feishu or lark) | Initial value: `feishu`                                |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#feishu).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use the message event’s sender `open_id` for **Allowed user IDs** and `message.chat_id` for **Chat ID**. The event header supplies `tenant_key`. A topic binding uses `message.thread_id`. An ordinary reply may have `root_id` without `thread_id`; bind it to the chat without a thread ID.

An ordinary chat destination uses the configured chat ID and app permissions. Sending inside a thread also requires a real message anchor received in an authenticated event for that account, chat and thread. Send a message in the chosen thread while Relanox is connected to establish it; a thread ID alone cannot supply that anchor.

## Enable the connection

Configure event subscription v2.0 with `https://relay.example.com/channels/feishu-main/events`, subscribe to `im.message.receive_v1`, and configure the same verification token and encryption key. Start Relanox before verifying the callback, then publish the app changes and make the bot available to your users.

Relanox uses the [official Feishu/Lark Node SDK](https://github.com/larksuite/node-sdk) for identity, credentials, message normalization, uploads and sending. HTTP callbacks remain on the configured Relanox address. Accepted messages are acknowledged after Core saves them; storage or download failures return an error so the platform can retry. SDK normalization supplies Markdown titles, mentions and media descriptions; message types without a textual representation can use an SDK placeholder. Delivery after a process or platform interruption still depends on the platform redelivering the callback.

## Send your first message

Open a conversation with the bot, or add it to the bound group and mention it with “Hello”. Use a user inside the app’s availability range and your sender allowlist.

When the Agent supplies `reply.requestId`, the reply references that exact incoming message, including inside a thread. Without `reply`, it sends normally to the conversation; a thread send uses its established root message to stay inside the thread.

## Images and files

Send images, audio, videos, files or rich posts with your question. Grant resource download/upload permissions such as `im:resource` or the applicable upload scope.

Uploads use the SDK and the platform enforces its current size and format limits, including images inside rich posts. Relanox retains its configured media budget (100 MiB by default), preserves ordered text/image layouts and bounds incoming downloads while reading them. A rejected native reply stays rejected if its source message disappears; it is not resent as an unrelated conversation message. Uncertain send results remain uncertain instead of automatically repeating a possibly accepted message.

## Troubleshooting

If callback verification fails, compare the token and encryption key on both sides. If some users cannot talk to the bot, check the published app’s availability range. For media failures, check resource permissions and reinstall/publish the permission changes as required by your organization.
