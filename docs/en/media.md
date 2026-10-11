# Images, audio, video and files

Relanox stores incoming media with its request and returns generated media to the original conversation. Support follows each channel's native protocol and permissions. Text and attachments form one durable request; a media-only message does not need placeholder text. Each send is an independent durable message.

The [channel guides](configuration.md) describe supported directions, formats and platform limits. IRC handles text messages. LINE receives files and sends images, audio and video. Google Chat bot-authenticated delivery uses image cards and download buttons. Teams file delivery depends on personal-chat consent. These distinctions also apply when a hosted agent can generate the requested file.

## Agent workflow

Incoming dot events and Grok Routine content directly include replyTo and attachment metadata: id, kind, mimeType, fileName, size, sha256 and optional durationMs/previewMediaId. They carry no binary bytes.

1. Read a received asset with `relanox_read_media({replyTo,mediaId})`. Images/audio up to 1 MiB return inline MCP content; other assets return a signed five-minute GET resource link scoped to the endpoint and input. Links themselves grant temporary access; keep them out of replies/logs.
2. Send text or attachments with `relanox_send_message`. Echo received media as `attachments:[{mediaId:"received-id"}]`. Generated files use `{url:"https://public.example/file",kind:"image",mimeType:"image/png",fileName:"picture.png"}`. The gateway downloads public HTTPS URLs with size/time bounds, DNS/address checks and no redirects, then atomically queues the bytes and message.
3. Provide positive integer durationMs when the platform requires audio/video duration. An image previewUrl downloads a generated companion atomically with its main asset; previewMediaId can reference a received image belonging to the same input. Previews need not be separate reply attachments.
4. Multiple sends are allowed for the same replyTo. Empty text requires attachments. Reuse an explicit idempotencyKey with identical content/attachment order to retry; absent a key, identical content deduplicates. Distinct explicit keys permit intentionally identical messages. `queued` does not mean delivered.

Direct SDK hosts can pass inline MediaUpload bytes or a `{media,preview}` pair to sendMessage; MCP clients provide public HTTPS URLs. Both dot and Grok expose the two media/message tools. Hosted clients must support relevant inline content or resource downloads, and generated files must be available through a public URL. Local protocol tests cover the media tools and transport.

## Public URLs for native delivery

The current adapters require public URLs for LINE image/audio/video output, Google Chat image cards and download buttons, and Teams group/channel images above 15,000 bytes. LINE requires HTTPS media URLs; Google Chat native attachment upload requires a separately authorized user identity rather than the configured bot. QQ uses native signed multipart uploads without publication. Teams personal-chat images above 15,000 bytes use native file consent and arrive as file cards; small images remain inline. For the remaining URL-based paths, add a public HTTPS origin at the top level of the CLI configuration:

```json
{
  "media": {
    "publicBaseUrl": "https://relay.example.com",
    "urlLifetimeMs": 86400000
  },
  "mediaLimits": {
    "maxMediaBytes": 26214400,
    "maxTotalMediaBytes": 52428800,
    "maxAttachments": 10
  }
}
```

Merge these fields into the configuration containing `relay`; this fragment is not a complete configuration. Forward `/media/*` to the business listener at the configured origin. The origin must have no path, query, fragment or embedded credentials. `allowInsecureLocalhost: true` explicitly permits loopback HTTP for local protocol tests; public platform fetches require reachable HTTPS.

Publication creates an opaque URL for one account, request and asset. It remains stable across retries and process restarts until its expiry. The default lifetime is 24 hours, with a maximum of seven days. Possession of a URL grants access until expiry or asset cleanup. Responses have `no-store` and `nosniff`; filenames and actual content types are preserved. The gateway does not infer the public origin from incoming Host or forwarded headers.

Direct-upload channels do not require this configuration. An adapter that requires publication reports an explicit configuration failure when no publisher is available. Private agent download URLs do not depend on `media.publicBaseUrl`; they use the authenticated MCP request's validated authority.

## Limits, persistence and recovery

Default relay limits are 25 MiB per asset, 50 MiB total and ten attachments per incoming request or outbound message. `mediaLimits` can change them up to 200 MiB per asset, 200 MiB total and ten attachments. Platform format and size limits still apply, including smaller image/preview limits. Generated assets share an atomic per-request budget of twice the configured attachment count and total bytes, counting inputs and previews as well as generated output.

Downloads enforce actual byte limits and timeouts, reject redirects and restrict credential forwarding to trusted platform origins. Untrusted remote media URLs cannot target private network addresses. Media bytes are stored in SQLite BLOBs or PostgreSQL bytea alongside request-owned metadata. Database backups therefore include attachments; account for their size and sensitivity.

Message enqueue commits text chunks first, followed by attachment chunks in the requested order. Each chunk has its own persisted progress and receipt. A failed later attachment does not repeat successful earlier chunks. Ambiguous external sends retain the normal `unknown` state and require explicit recovery; restarting does not imply that a platform send was safe to repeat.

Retention redacts eligible incoming text/context/attachment lists, outbound content/receipts and binary bytes. Durable deduplication and routing metadata, including stored media filenames/hashes, remain. Due/unknown notifications and undelivered messages are preserved. Cleanup can invalidate an otherwise unexpired public URL. Configure the retention interval to leave enough time for native platform downloads and user access to download buttons. See [Operations](operations.md) for backup and recovery commands.
