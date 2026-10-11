# Send pictures and files

After connecting a channel and an Agent, you can share pictures, audio, videos and files in your chat. Send a screenshot for an explanation, ask for the main points of a document, or have the Agent send back an image it creates.

Start with a small picture and ask, “Please describe this image.” Once the Agent reads it and replies, try the other file types you need.

## Send an attachment

Send a small image in the chat you selected in the [connection configurator](connect.md), and ask the Agent to describe it. You do not need a separate attachment prompt or connection. For audio, video and other files, check your [channel guide](channels/index.md) for supported formats and any duration or cover-image requirements.

## Receive a file from the Agent

Ask the Agent to send its generated file back to the chat. It needs a public HTTPS link that downloads the file directly. If it provides a link, open it in a browser and check that the file downloads.

LINE, Google Chat and large images in Teams groups or channels also need Relanox's public HTTPS address for delivery. Use the address entered in the configurator and follow [Deployment and daily use](operations.md) to make it reachable. Teams personal chats may ask you to accept the file. IRC supports text conversations.

Relanox download links normally last 24 hours. Anyone holding a valid link can download its file, so share it only with the intended recipients.

## Choose a suitable file size

Start with files below 25 MiB each, at most 50 MiB in one message and no more than 10 attachments. Your chat platform may have lower limits. If a file is too large, compress it or send smaller batches.

To change the size limits or download-link lifetime, use [Media configuration and protocol](reference/media.md). That chapter also documents manual JSON settings and the tools used by the Agent.

## Where files are stored

Relanox saves received attachments in your configured database. A database backup includes those files, so allow enough storage for pictures and videos.

Routine cleanup removes eligible old attachments, which also expires their download links. Leave enough time for recipients to download their files before cleaning up. See [Backups and cleanup](operations.md) for the commands.

## If an attachment does not arrive

1. Send a text message to check that your account and Agent are connected.
2. Try a small image to check whether the issue concerns file type or size.
3. For a generated file, open its download address and confirm it downloads directly.
4. For LINE, Google Chat or Teams group images, check the public HTTPS address.
5. Check [message status and recovery](reference/core.md) for the next action.
