# Send pictures and files

After connecting a channel and an Agent, you can share pictures, audio, videos and files in your chat. Send a screenshot for an explanation, ask for the main points of a document, or have the Agent send back an image it creates.

Start with a small picture and ask, “Please describe this image.” Once the Agent reads it and replies, try the other file types you need.

## Send an attachment

Send a small image in the chat you selected in the [connection configurator](connect.md), and ask the Agent to describe it. You do not need a separate attachment prompt or connection. For audio, video and other files, check your [channel guide](channels/index.md) for supported formats and any duration or cover-image requirements.

Small UTF-8 text, Markdown, CSV, TSV and JSON files up to 64 KiB can be read directly through the connection. Larger files and other formats require the Agent to download them; its network or file support may limit what it can read.

## Receive a file from the Agent

Try: “Create a small text file containing today’s checklist and send it as an attachment in this chat.” You should receive a downloadable file in the original chat, rather than only a filename or a message saying the file is ready.

Ask the Agent to send its generated file back to the chat. dot can pass files from its workspace through the MCP file parameter. Grok Bot can upload a file from its cloud computer to Relanox, then send it as an attachment. A direct public HTTPS download link also works.

After updating Relanox, refresh or reconnect the Agent's MCP connection so it sees the file tools. The connection supplies the upload instructions; no separate file service or prompt is required. Uploading saves the file, and the Agent must then send it to your chat. If Grok still lists only two tools, its connection has an older tool list; reconnect it and confirm that Create upload appears.

Grok may ask you to approve uploading the generated file from its cloud computer. Check the filename and your Relanox address before allowing that upload. While it is waiting for approval, the original chat will not receive the attachment.

LINE, Google Chat and large images in Teams groups or channels also need Relanox's public HTTPS address for delivery. Use the address entered in the configurator and follow [Deployment and daily use](operations.md) to make it reachable. Teams personal chats may ask you to accept the file. IRC supports text conversations.

Relanox download links normally last 24 hours. Anyone holding a valid link can download its file, so share it only with the intended recipients.

## Choose a suitable file size

Start with files below 25 MiB each, at most 50 MiB in one message and no more than 10 attachments. Your chat platform may have lower limits. If a file is too large, compress it or send smaller batches.

To change the size limits or download-link lifetime, use [Media configuration and protocol](reference/media.md). That chapter also documents manual JSON settings and the tools used by the Agent.

## Where files are stored

Relanox saves received attachments and Agent uploads in your configured database. A database backup includes those files, so allow enough storage for pictures and videos.

Routine cleanup removes eligible old attachments, which also expires their download links. Leave enough time for recipients to download their files before cleaning up. See [Backups and cleanup](operations.md) for the commands.

## If an attachment does not arrive

1. Send a text message to check that your account and Agent are connected.
2. Try a small image to check whether the issue concerns file type or size.
3. For a generated file, check whether the upload completed and the Agent sent the returned file ID. If it used a download link, confirm that it downloads directly.
4. For LINE, Google Chat or Teams group images, check the public HTTPS address.
5. Check [message status and recovery](reference/core.md) for the next action.
