# WeChat

Connect a QR-paired WeChat iLink bot to private conversations. Relanox polls the native API; this channel does not require an incoming webhook. The Agent still needs your public HTTPS MCP address.

## Pair the bot

Build Relanox, then run from the repository root:

```sh
node apps/cli/dist/main.js wechat-login --output data/wechat.json
```

Scan the terminal QR code with WeChat and complete the confirmation on your phone. The command prints connection status and saves `botId`, `botToken`, `apiBaseUrl` and the scanning user's `userId` in the new JSON file. It never overwrites an existing file and does not modify `relanox.json`. Keep the credential file private and out of commits.

If your phone asks for a verification code, run with a code file:

```sh
node apps/cli/dist/main.js wechat-login --output data/wechat.json --verification-code-file data/wechat-code.txt --timeout 300
```

While the command is running, write the phone's code into that file. The command reads it when verification is requested. If it reports `wechat_verification_code_rejected`, replace the file contents with the corrected code; it waits for a changed value before resubmitting. Remove the code file afterward. The default deadline is 180 seconds; `--timeout` accepts 1–600 seconds. If the QR code expires, rerun the command. A failed attempt removes its incomplete output file.

## Fill in the configurator

Open the [connection configurator](../connect.md) and choose **WeChat**. Copy `botId` from the credential file into the bot ID field. Set both **Allowed user IDs** and **Chat ID** to the returned `userId` for your own private conversation. Keep the complete native identifiers, including their suffixes. Leave **Thread ID** empty and choose the **Receiving Agent**.

Copy the returned `apiBaseUrl` into the configurator's API base URL field; regional accounts may use a different origin from the default `https://ilinkai.weixin.qq.com`. Download `relanox.json` and set `WECHAT_BOT_TOKEN` to the saved `botToken` in the environment that starts Relanox. The login JSON is a credential export, not a service configuration, and Relanox does not load it automatically.

For a PowerShell launch, load the token without printing it:

```powershell
$wechat = Get-Content data/wechat.json -Raw | ConvertFrom-Json
$env:WECHAT_BOT_TOKEN = $wechat.botToken
```

Set the Agent's environment variables as described in [Connect an Agent](../agents.md), validate the configuration, then start Relanox:

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
```

Manual account and binding examples are in the [technical reference](../reference/channels.md#wechat).

## Send your first message

Send a short question to the paired bot from the allowed WeChat user. Confirm that the answer arrives in that same private conversation. Group chats and threads are unavailable.

A real incoming message establishes the conversation context required to send. A configured user ID alone does not make a destination available. Relanox saves that context and the poll cursor in its database and restores them after restart. Retain the database alongside your account credentials.

## Images and files

You can send images, voice messages, videos and files. Relanox downloads and decrypts supported native media before forwarding it to the Agent. Voice transcripts are included when WeChat supplies them; the original audio remains available when its media reference can be downloaded. Raw voice codecs may require the optional [speech recognition middleware](../reference/configuration.md#speech-to-text) or support in the Agent.

Replies support text, images, videos and files. Outgoing audio is unavailable. Text and media arrive as separate messages in reading order. Markdown is sent as text; WeChat's client decides how it is displayed. Relanox splits long replies at 4,000 Unicode code points per text part.

## Troubleshooting

For `missing_context`, send a new message in the bound private chat. Check that its complete sender ID matches both the allowlist and binding. For `wechat_session_expired`, pair again into a new credential file, update the bot identity and token where necessary, then restart. Polling pauses for one hour after the native expiration response.

If an attachment cannot be downloaded, check access to the configured WeChat CDN. Transient download failures keep the previous cursor so the message can be retried. Before retrying an uncertain outgoing message, inspect its delivery status; the native client ID is not treated as a guaranteed deduplication mechanism.

The integration has local protocol and restart coverage. These checks do not establish live WeChat account compatibility. The [Tencent iLink protocol reference](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md) describes the native requests and media encryption.
