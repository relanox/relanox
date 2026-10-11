# Feishu / Lark

Connect an internal Feishu or Lark application bot to your agent.

## Prepare your account

Create an internal application, enable its bot capability and grant message reception, sending and resource access permissions. Record the app ID and tenant key; save the app secret, event verification token and encryption key in the environment variables shown below. For Lark, select lark in **Platform domain**.

## Fill in the configurator

Open the [connection configurator](../configuration.md), select **Feishu / Lark**, and enter the account details and secret environment variable names obtained above. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field                      | What to enter                              |
| --------------------------------------- | ------------------------------------------ |
| Application ID                          | Replace example: `cli_example`             |
| Application secret environment variable | Variable name: `FEISHU_APP_SECRET`         |
| Verification token environment variable | Variable name: `FEISHU_VERIFICATION_TOKEN` |
| Encryption key environment variable     | Variable name: `FEISHU_ENCRYPT_KEY`        |
| Tenant key                              | Replace example: `example-tenant`          |
| Platform domain (feishu or lark)        | Initial value: `feishu`                    |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#feishu).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

Use the message event’s sender `open_id` for **Allowed user IDs** and `message.chat_id` for **Chat ID**. The event header supplies `tenant_key`; the bot identity can be obtained from the bot information API. A thread binding uses `message.thread_id`, or `root_id` when that is the supplied thread reference.

## Enable the connection

Configure event subscription v2.0 with `https://relay.example.com/channels/feishu-main/events`, subscribe to `im.message.receive_v1`, and configure the same verification token and encryption key. Start Relanox before verifying the callback, then publish the app changes and make the bot available to your users.

## Send your first message

Open a conversation with the bot, or add it to the bound group and mention it with “Hello”. Use a user inside the app’s availability range and your sender allowlist.

## Images and files

Send images, audio, videos, files or rich posts with your question. Grant resource download/upload permissions such as `im:resource` or the applicable upload scope. Replies can contain images up to 10 MiB and other uploads up to 30 MiB, within the relay limit.

## Troubleshooting

If callback verification fails, compare the token and encryption key on both sides. If some users cannot talk to the bot, check the published app’s availability range. For media failures, check resource permissions and reinstall/publish the permission changes as required by your organization.
