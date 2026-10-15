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

To send to a bound destination before Relanox receives a message there, add `recipientTypes` to the downloaded account's `config`: map its **Chat ID** to `single` for a staff member or `group` for an open conversation. Without this setting, Relanox learns the recipient type from authenticated message events. The robot still needs the independent message API permissions and access to that recipient. Leave **Thread ID** empty. See the [manual example](../reference/channels.md#dingtalk).

## Enable the connection

Start Relanox after saving the account configuration. It opens the Stream connection automatically using the application credentials. Keep outbound HTTPS and WebSocket access available. Restart Relanox after rotating the application secret so the Stream SDK receives the new credential.

The channel uses the official [`dingtalk-stream` SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) for connection setup, heartbeats, recovery, callback dispatch and ACK frames, and `@alicloud/dingtalk` for OAuth, message sending and download URLs. Stream is pinned to the official [2.1.7-beta.1 prerelease](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/releases/tag/v2.1.7-beta.1), which fixes cancellation cleanup and keeps delayed callback ACKs on their receiving socket. SDK recovery and queue behavior apply. Accepted callbacks are acknowledged after durable ingest; known policy or unsupported-input rejections receive the SDK's terminal success ACK. Storage or download failures remain unacknowledged for platform redelivery. Core still controls permissions, bindings and send retries. SDK message POST retries are disabled; rate limits use a one-second Core retry delay because the generated gateway does not expose `Retry-After`. An already dispatched OpenAPI call can complete during cancellation; media downloads and the legacy upload retain abort support.

## Send your first message

Send “Hello” to the application robot from an allowed staff member. In a group, mention the robot; the group event must indicate that the bot was addressed.

The current application-robot send endpoints do not provide a verified native quote parameter. The Agent can supply `reply.requestId` to associate a reply with the selected request and track completion, but DingTalk sends it as an ordinary conversation message without a quote bubble. Omitting `reply` also sends an ordinary message. The [official SDK request models](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/robot_1_0/client.go) define the supported group and single-user send parameters; Relanox does not substitute a message ID into an undocumented field.

## Images and files

Send pictures, audio, videos, files or rich-text messages. Common formats include JPEG/PNG/GIF/BMP images, MP4 video, AMR audio and office documents. The Core media budget is 100 MiB; DingTalk validates each upload's size and format, so it can refuse a file below that budget. Refusals are returned to Core for ordinary and rich-text uploads. The generated SDK does not cover the legacy `/media/upload` multipart endpoint, so only that upload remains a narrow HTTP call. Inbound downloads retain URL, redirect and byte-limit protection. Generated audio needs a duration; video also needs an image preview and duration.

## Troubleshooting

If the robot connects but sends no reply, check the independent message API permissions and the staff/group availability. If private questions are filtered, compare `senderId` with the allowlist and `senderStaffId` with the binding. For group failures, check the robot code and group membership.
