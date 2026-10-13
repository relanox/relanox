# Media configuration and protocol

After connecting a channel and an Agent, you can share pictures, audio, videos and files in your chat. Send a screenshot for an explanation, ask for the main points of a document, or have the Agent send back an image it creates.

Start with a small picture and ask, “Please describe this image.” Once the Agent reads it and replies, try the other file types you need.

## Let the Agent read attachments

The MCP connection provides attachment instructions and the `relanox_read_media`, `relanox_send_message` and `relanox_create_upload` tools. The Agent uses `source.channel.id` as `channel` and the incoming attachment `id` as `mediaId`. These IDs arrive with the message; no separate attachment prompt is needed. See [Connect an Agent](../agents.md) for setup and [Agent protocol](agents.md#incoming-messages) for the payload.

Media is owned by an authorized channel. Read, upload and send calls must select that channel. A `mediaId` from another channel cannot be used, including as a preview. Use `relanox_status` to discover authorized channels and their supported media before uploading or sending.

`relanox_read_media` returns all attachments as download resource links valid for five minutes, regardless of file type or size. Download the file before inspecting its contents. That link lifetime controls access, not asset retention. If the Agent cannot download or read the file, it should explain the limitation. Downloading an audio file does not by itself provide speech recognition.

## Receive files created by the Agent

dot can supply generated files through `relanox_send_message.files`, using the host's `openai/fileParams` file objects. Relanox downloads the supplied temporary URL and saves the bytes before sending. The OpenAI `file_id` is not a Relanox media ID.

Grok Bot can call `relanox_create_upload`, PUT a file from its cloud computer to the returned signed URL, and use the successful response's `fileId` as `attachments[].mediaId`. This upload tool is also available to dot when it can use a terminal or HTTP tool. Uploads use the existing public address and database; no separate object-storage account is needed. See [Agent file tools](agents.md#upload-a-local-file) for the protocol and examples.

A direct public HTTPS URL is also accepted in `attachments`. It must return the file itself. Audio/video destinations may require `durationMs` and a cover image; use the upload tool or URL attachment parameters for this metadata. Check the [channel guide](../channels/index.md) before sending.

Signed upload URLs last five minutes and authorize one immutable file for the selected `channel`. Retrying the same URL with identical bytes succeeds while it is valid; different bytes cannot overwrite the file. Uploading saves the file but does not send it. Keep the returned file ID for the send call. Treat upload URLs as temporary credentials. The five-minute lifetime limits access through that URL; it does not automatically delete the uploaded asset.

For a new send, use a fresh `idempotencyKey`, such as a UUID. Retry the same send with that key, identical text and the same attachment content and order. Omitting the key creates a new message on every call, even with identical content. A `queued` result means saved for delivery. Use its `deliveryId` with `relanox_status` to check progress rather than submitting another send with a new key.

## Ordered Markdown media {#ordered-markdown-media}

`relanox_send_message.text` accepts internal media references in Markdown links and images:

```markdown
The first result:

![Result image](relanox://media/12345678-1234-1234-1234-123456789abc)

The explanation continues here.

[Download report](relanox://attachment/1)
```

`relanox://media/<UUID>` selects received or uploaded media owned by the send's authorized `channel`. Relanox resolves it automatically; do not add it to `attachments` just to make the reference work. `relanox://attachment/<number>` selects a file supplied in this send, counting `attachments` first, then dot's `files`, starting at 1. The number must select an existing entry. These are internal references, not download URLs.

Use `![label](...)` for an image and `[filename](...)` for a standalone file. Image syntax requires image media; links send the referenced media separately with the label as preceding text. Each file may be referenced once. Repeated references, including selecting the same file by both ID and position, fail before enqueueing. Unreferenced attachments follow the Markdown content in their supplied order.

Malformed or out-of-range references return `invalid_media_reference`; image syntax selecting other media returns `invalid_image_reference`; repeated files return `duplicate_attachment`. Channel ownership and existing media limits still apply.

Inline links, images and reference-style definitions are supported. Code spans, fenced code, escaped syntax and HTML attributes do not create media references. Ordinary HTTPS images and links keep their Markdown meaning and are not automatically downloaded. Use an explicit URL attachment when you want Relanox to download a file. With media references, text fragments keep balanced inline formatting; lists and quotes are rebuilt, and tables become rows of pipe-separated cells.

`relanox_status.channels[].richText` reports `native`, `sequential`, `text-then-images` or `text-only`. Native channels expose `richTextLimits` with `maxParts`, `maxTextLength` and optional `imageMimeTypes` and `maxImageBytes`. Text and image parts count toward the native layout limits. An image outside the inline MIME or byte limits uses the channel's standalone image delivery at that position, once; normal attachment limits still apply. See [Channel layouts](channels.md#rich-media) for native formats and exceptions. Local protocol tests cover the generated requests; they do not establish live-account compatibility.

The declared inline image limits are:

| Channel            | Image formats                           | Maximum inline bytes            |
| ------------------ | --------------------------------------- | ------------------------------- |
| Feishu / Lark      | PNG, JPEG, GIF, WebP, BMP               | 10 MiB                          |
| DingTalk           | PNG, JPEG, GIF, BMP                     | 20 MiB                          |
| Slack              | PNG, JPEG, GIF                          | 25 MiB                          |
| Google Chat        | PNG, JPEG                               | 2,000,000 bytes                 |
| Microsoft Teams    | PNG, JPEG, GIF                          | 1,000,000 bytes                 |
| LINE               | PNG, JPEG                               | 10,000,000 bytes                |
| QQ                 | PNG, JPEG                               | 20 MiB                          |
| Discord            | No additional MIME restriction declared | 10 MiB                          |
| Matrix, Mattermost | No additional MIME restriction declared | Configured per-file media limit |

Configured media limits may lower these values. Use status for the active limit. DingTalk and QQ also limit the serialized Markdown, including image references, to 4,000 and 2,000 UTF-8 bytes respectively. Native layout support still depends on the platform and client.

## Set up a file download address for your channel

These delivery methods need a public HTTPS address served by Relanox:

| Channel         | Content using the address                                                              |
| --------------- | -------------------------------------------------------------------------------------- |
| LINE            | Images, audio and video                                                                |
| Google Chat     | Image cards and file download buttons                                                  |
| Microsoft Teams | Native inline images; standalone images larger than 15,000 bytes in groups or channels |
| Mattermost      | Native inline images                                                                   |
| QQ              | Native Markdown images                                                                 |

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

Chat platforms have their own file requirements too. Check the type and size before sending. `relanox_status.mediaLimits` reports the configured per-message limits as `maxBytes`, `maxTotalBytes` and `maxAttachments`; each channel also reports its supported media and attachment limit. Cover-image bytes count toward the message's total size. For a size error, try compressing the file, sending smaller batches or adjusting Relanox's settings.

Outstanding staged uploads have a separate per-channel allowance of twice `maxAttachments` and twice `maxTotalMediaBytes`. This bounds files waiting to be used; it is not a cumulative lifetime limit for the chat. Enqueueing a message releases the staged allowance for the assets it uses, and cleanup releases it for removed uploads. Each send still has to fit the per-message limits. Previews must be image assets owned by the same channel.

## Where files are stored

Relanox saves received attachments and Agent uploads in your configured database. Staged uploads occupy the per-channel allowance until used by an enqueued message or removed by cleanup. A database backup includes those files, so allow enough storage for pictures and videos.

Routine cleanup removes eligible old attachments, which also expires their download links. Leave enough time for recipients to download their files before cleaning up. See [Backups and cleanup](../operations.md) for the commands.

Retained media metadata and send receipts allow an identical keyed send to return its previous delivery after cleanup. This replay does not restore deleted file bytes or make a cleaned attachment readable again. A new send needs available bytes.

## If an attachment does not arrive

1. Send a text message to check that your account and Agent are connected.
2. Try a small image to check whether the issue concerns file type or size.
3. For a generated file, check that the upload returned a file ID and the Agent used it in a send call. For URL attachments, confirm that the address downloads the file directly.
4. For LINE, Google Chat or Teams group images, check the download address settings above.
5. Check [message status and recovery](core.md) for the next action.
