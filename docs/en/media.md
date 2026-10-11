# Images, audio, video and files

Relanox stores incoming media with its request and returns generated media to the original conversation. Support follows each channel's native protocol and permissions. Text and attachments form one durable request; a media-only message does not need placeholder text. Replies are final results, without streaming updates.

The [channel guides](configuration.md) describe supported directions, formats and platform limits. IRC has no standardized native attachment transport. LINE cannot send arbitrary files through the Messaging API. Google Chat bot-authenticated delivery uses image cards and download buttons; those buttons are not native uploaded file attachments. Teams file delivery depends on personal-chat consent. These distinctions also apply when a hosted agent can generate the requested file.

## Agent workflow

The request returned by `relanox_list_pending` and `relanox_claim` includes attachment metadata: `id`, `kind`, `mimeType`, `fileName`, `size`, `sha256`, and optional `durationMs` / `previewMediaId`. Binary bytes are not embedded in the Routine or notification JSON.

1. Claim the request before reading or generating assets.
2. Call `relanox_read_media` with `requestId`, `claimToken` and `mediaId`. Images and audio up to 1 MiB return inline MCP content. Other media return a resource link to a binary download.
3. For generated media, choose a stable UUID and call `relanox_media_transfer` with `method: "PUT"`, that `mediaId`, the request/claim, and metadata. PUT the raw file bytes to the returned URL. A successful response supplies the stored `media.id`.
4. Complete with the final `text` and ordered `attachments: ["media-id", ...]`. Empty text is valid when attachments are present. Existing request attachments may also be included. Reuse the same result ID, text and attachment order on retries.

Upload metadata contains `kind` (`image`, `audio`, `video` or `file`), `mimeType` and a plain `fileName`. Supply positive integer `durationMs` when the destination requires audio/video duration. Upload an image first and use its ID as `previewMediaId` when a native video or image preview is required. The preview must belong to the same request. A preview need not appear as a separate final attachment.

Transfer URLs expire after five minutes and are bound to the endpoint, request, claim, method and metadata. They authorize access themselves; do not put them into channel replies or logs. A retried upload uses the same UUID and bytes. Reusing the UUID with changed bytes or metadata conflicts. Requeueing the request revokes the old claim. These private transfer URLs are separate from native platform download URLs below.

Both dot and Grok expose the media tools. The hosted client must support inline MCP media, resource downloads and raw binary PUT for the relevant workflow. Local protocol tests exercise actual MCP requests, storage and byte transfer; they do not establish that a particular hosted account automatically downloads resources or uploads generated files. Configure and verify that client behavior before relying on it.

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

Default relay limits are 25 MiB per asset, 50 MiB total and ten attachments per incoming request or final result. `mediaLimits` can change them up to 200 MiB per asset, 200 MiB total and ten attachments. Platform format and size limits still apply, including smaller image/preview limits. Staged assets share an atomic per-request budget of twice the configured attachment count and total bytes, counting inputs and previews as well as generated output.

Downloads enforce actual byte limits and timeouts, reject redirects and restrict credential forwarding to trusted platform origins. Untrusted remote media URLs cannot target private network addresses. Media bytes are stored in SQLite BLOBs or PostgreSQL bytea alongside request-owned metadata. Database backups therefore include attachments; account for their size and sensitivity.

Completion commits text chunks first, followed by attachment chunks in the requested order. Each chunk has its own persisted progress and receipt. A failed later attachment does not repeat successful earlier chunks. Ambiguous external sends retain the normal `unknown` state and require explicit recovery; restarting does not imply that a platform send was safe to repeat.

Retention removes media bytes and identifying metadata only when the request is eligible for cleanup, preserving unfinished requests and undelivered results. Cleanup can invalidate an otherwise unexpired public URL. Configure the retention interval to leave enough time for native platform downloads and user access to download buttons. See [Operations](operations.md) for backup and recovery commands.
