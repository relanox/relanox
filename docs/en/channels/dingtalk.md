# DingTalk application robot

Connect a DingTalk application robot for private questions and group conversations.

## Prepare your account

Create an application robot, record its client ID and robot code, and save its app secret as `DINGTALK_APP_SECRET`. Enable Stream reception. Grant the robot the independent single-user/group message API permissions and media download/upload permissions. Add it to the intended groups and make it available to the intended staff.

## Fill in the configurator

Open the [connection configurator](../connect.md), select **DingTalk**, and enter the account details obtained above. Keep credential variable names at their defaults and set the actual secrets using the generated tutorial after downloading. Put the sender IDs described below in **Allowed user IDs**, the conversation ID in **Chat ID**, and the topic ID in **Thread ID** when applicable. Select the **Receiving Agent**. Separate multiple allowed users with commas.

| Configurator field | What to enter                                      |
| ------------------ | -------------------------------------------------- |
| Client ID          | The client id obtained during account preparation  |
| Robot code         | The robot code obtained during account preparation |

Download the configuration as `relanox.json` and set the secret variables in the environment that starts the service. Complete the platform connection steps below, then start or restart the service and follow **Send your first message** to verify the reply. Manual configuration and protocol parameters are in the [technical reference](../reference/channels.md#dingtalk).

Ask the bot administrator to provide the user and conversation IDs listed below before filling in the configuration. They can verify these values against existing bot message records. Use the IDs assigned by the platform rather than display names.

The sender allowlist uses the callback’s opaque `senderId`, including any prefix. A direct-chat **Chat ID** uses `senderStaffId`; a group **Chat ID** uses `conversationId` (the open conversation ID). Read these values from an application-robot message event. The sender and direct-chat identifiers serve different purposes, so copy each exact field.

## Enable the connection

Start Relanox after saving the account configuration. It opens the Stream connection automatically using the application credentials. Keep outbound HTTPS and WebSocket access available.

## Send your first message

Send “Hello” to the application robot from an allowed staff member. In a group, mention the robot; the group event must indicate that the bot was addressed.

## Images and files

Send pictures, audio, videos, files or rich-text messages. Replies can include JPEG/PNG/GIF/BMP images, MP4 video and files up to 20 MiB, and AMR audio up to 2 MiB, within the relay limit. File replies use XLSX, PDF, ZIP, RAR, DOC or DOCX formats.

## Troubleshooting

If the robot connects but sends no reply, check the independent message API permissions and the staff/group availability. If private questions are filtered, compare `senderId` with the allowlist and `senderStaffId` with the binding. For group failures, check the robot code and group membership.
