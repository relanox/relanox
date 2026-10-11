# Send pictures and files

After connecting a channel and an Agent, you can share pictures, audio, videos and files in your chat. Send a screenshot for an explanation, ask for the main points of a document, or have the Agent send back an image it creates.

Start with a small picture and ask, “Please describe this image.” Once the Agent reads it and replies, try the other file types you need.

## Let the Agent read attachments

Add this to your Agent's saved instructions:

> When a message contains attachments, use relanox_read_media to read them as needed. Send your answer with relanox_send_message using the replyTo from that message.

Connecting Relanox makes these tools available to the Agent. You can continue sending attachments normally in your chat. See [Connect an Agent](agents.md) for setup.

## Receive files created by the Agent

To send a generated image or file, the Agent supplies a public HTTPS address that downloads the file directly. Relanox retrieves it and sends it using your chat platform's delivery method.

You can add this instruction:

> To send a generated file, include its HTTPS download address, type and filename in the attachments for relanox_send_message. For audio or video, include the duration and cover image required by the destination channel.

The address should return the file itself. Open it in a browser to check that it downloads. Before sending audio or video, check the [channel guide](channels/index.md) for formats, duration and cover images.

## Set up a file download address for your channel

These delivery methods need a public HTTPS address served by Relanox:

| Channel         | Content using the address                                  |
| --------------- | ---------------------------------------------------------- |
| LINE            | Images, audio and video                                    |
| Google Chat     | Image cards and file download buttons                      |
| Microsoft Teams | Images larger than 15,000 bytes in group chats or channels |

Add `media` at the top level of `relay.json`, alongside `relay`:

```json
{
  "media": {
    "publicBaseUrl": "https://relay.example.com",
    "urlLifetimeMs": 86400000
  }
}
```

Replace `relay.example.com` with your domain. Configure your reverse proxy to forward requests under `/media/` to Relanox's service port, which defaults to `8787`. See [Deployment and daily use](operations.md) for domain setup.

Download links last 24 hours by default. Anyone with a link can access the file while it is valid, so treat it as a temporary file-sharing link. `urlLifetimeMs` is measured in milliseconds and can be set up to seven days.

Large images and files in Teams personal chats use the platform's file consent flow. IRC handles text conversations; LINE receives files and sends images, audio and video. Each [channel guide](channels/index.md) explains how files appear in that app.

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

Relanox saves received attachments in your configured database. A database backup includes those files, so allow enough storage for pictures and videos.

Routine cleanup removes eligible old attachments, which also expires their download links. Leave enough time for recipients to download their files before cleaning up. See [Backups and cleanup](operations.md) for the commands.

## If an attachment does not arrive

1. Send a text message to check that your account and Agent are connected.
2. Try a small image to check whether the issue concerns file type or size.
3. For a generated file, open its download address and confirm it downloads directly.
4. For LINE, Google Chat or Teams group images, check the download address settings above.
5. Check [message status and recovery](reference/core.md) for the next action.
