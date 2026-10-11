# Media configuration and protocol

After connecting a channel and an Agent, you can share pictures, audio, videos and files in your chat. Send a screenshot for an explanation, ask for the main points of a document, or have the Agent send back an image it creates.

Start with a small picture and ask, “Please describe this image.” Once the Agent reads it and replies, try the other file types you need.

## Let the Agent read attachments

The MCP connection provides attachment instructions and the `relanox_read_media`, `relanox_send_message` and `relanox_create_upload` tools. The Agent uses the incoming attachment `id` as `mediaId` and keeps the message’s `replyTo` when reading or replying. No separate attachment prompt is needed. You can continue sending attachments normally in your chat. See [Connect an Agent](../agents.md) for setup.

## Receive files created by the Agent

dot can supply generated files through `relanox_send_message.files`, using the host's `openai/fileParams` file objects. Relanox downloads the supplied temporary URL and saves the bytes before sending. The OpenAI `file_id` is not a Relanox media ID.

Grok Bot can call `relanox_create_upload`, PUT a file from its cloud computer to the returned signed URL, and use the successful response's `fileId` as `attachments[].mediaId`. This upload tool is also available to dot when it can use a terminal or HTTP tool. Uploads use the existing public address and database; no separate object-storage account is needed. See [Agent file tools](agents.md#upload-a-local-file) for the protocol and examples.

A direct public HTTPS URL is also accepted in `attachments`. It must return the file itself. Audio/video destinations may require `durationMs` and a cover image; use the upload tool or URL attachment parameters for this metadata. Check the [channel guide](../channels/index.md) before sending.

Signed upload URLs last five minutes and authorize one immutable file for the original `replyTo`. Retrying the same URL with identical bytes succeeds; different bytes cannot overwrite the file. Uploading saves the file but does not send it. Keep the returned file ID to retry the send without uploading again. Treat upload URLs as temporary credentials.

## Set up a file download address for your channel

These delivery methods need a public HTTPS address served by Relanox:

| Channel         | Content using the address                                  |
| --------------- | ---------------------------------------------------------- |
| LINE            | Images, audio and video                                    |
| Google Chat     | Image cards and file download buttons                      |
| Microsoft Teams | Images larger than 15,000 bytes in group chats or channels |

Set top-level `publicUrl` in `relanox.json`. If you already set it for your Agent connection, media uses the same address automatically:

```json
{
  "publicUrl": "https://relay.example.com"
}
```

Replace `relay.example.com` with your domain. Configure your reverse proxy to forward requests under `/media/` to Relanox's service port, which defaults to `8787`. See [Deployment and daily use](../operations.md) for domain setup.

Download links last 24 hours by default. Anyone with a link can access the file while it is valid, so treat it as a temporary file-sharing link. To change this, add an optional `media` object such as `"media": { "urlLifetimeMs": 3600000 }` for one hour. The value is measured in milliseconds and can be set up to seven days.

Large images and files in Teams personal chats use the platform's file consent flow. IRC handles text conversations; LINE receives files and sends images, audio and video. Each [channel guide](../channels/index.md) explains how files appear in that app.

## Adjust attachment sizes

The defaults allow 25 MiB per attachment, 50 MiB in one message and up to 10 attachments. Add `mediaLimits` at the top level of your configuration to adjust these values:

```json
{
  "mediaLimits": {
    "maxMediaBytes": 26214400,
    "maxTotalMediaBytes": 52428800,
    "maxAttachments": 10
  }
}
```

The first two values are measured in bytes: the size of one attachment and the combined size for one message. Both can be set up to 200 MiB. `maxAttachments` can be set up to 10. Restart Relanox after editing the settings.

Chat platforms have their own file requirements too. Check the type and size before sending. For a size error, try compressing the file, sending smaller batches or adjusting Relanox's settings. Received attachments, generated files and cover images for one incoming message also share an overall allowance of twice the configured attachment count and total size.

## Where files are stored

Relanox saves received attachments and Agent uploads in your configured database. Uploads count toward the original message's overall attachment allowance even before they are sent. A database backup includes those files, so allow enough storage for pictures and videos.

Routine cleanup removes eligible old attachments, which also expires their download links. Leave enough time for recipients to download their files before cleaning up. See [Backups and cleanup](../operations.md) for the commands.

## If an attachment does not arrive

1. Send a text message to check that your account and Agent are connected.
2. Try a small image to check whether the issue concerns file type or size.
3. For a generated file, check that the upload returned a file ID and the Agent used it in a send call. For URL attachments, confirm that the address downloads the file directly.
4. For LINE, Google Chat or Teams group images, check the download address settings above.
5. Check [message status and recovery](core.md) for the next action.
