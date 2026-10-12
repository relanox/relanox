# Adding an integration

This guide is for contributors adding a native messaging integration or extending an agent integration. If you only want to connect a supported account, use its [channel guide](../channels/index.md) and [Configuration](../configuration.md); you do not need to use the SDK.

## Start with the public SDK

`@relanox/sdk` provides the types used by channels, agents and storage. Its public entrypoint is `packages/sdk/src/index.ts`. Use the exported types and an existing integration with a similar transport as your starting point. See [Contributing](../development.md) for installation and checks.

A channel integration receives platform events and sends replies. An agent integration authenticates an agent, notifies it of inputs, and accepts its replies. Relanox supplies each integration with a scoped host that saves messages and checks access. Use that host rather than opening the database directly.

## Add a channel

1. Define and validate the account configuration. Require environment references for secrets; validation should check values without making network calls.
2. Authenticate incoming platform events, extract a stable event ID, and pass text, supported attachments and conversation information to the channel host. Wait for the host to save the input before acknowledging the platform event.
3. Declare platform text limits and supported media kinds. Relanox splits text before sending; your adapter handles native uploads and downloads.
4. Implement `resolveChannel(address, learned)` to turn a bound `ChannelAddress` into a native destination, or return an unavailable reason. Use authenticated native context where the platform requires it; do not fabricate an incoming message. Availability is a snapshot, so recheck expiring windows and credentials during sending.
5. Implement sending for one prepared message part at a time. Preserve its send identity across retries, report the platform receipt on success, and distinguish a known temporary failure from an uncertain result.
6. Register any webhook handlers through the host. The application owns listening addresses and mounts channel routes under `/channels/<accountId>`.

Reply text is Markdown. Declare `capabilities.maxTextLength` and `lengthUnit` for the platform limit. Core splits Markdown while keeping formatting and links complete. If the rendered payload has a different size, implement `splitText(markdown, target)` with `@relanox/markdown` and measure the destination representation. Native Markdown channels send the source; other channels render it as the platform's supported formatting. There is no separate plain-text mode.

Use `capabilities.maxChunksPerMessage` to limit the total text and media parts in one reply, `maxAttachmentsPerMessage` for the attachment count, and `maxTextLengthPerMessage` for the total source Markdown length using `lengthUnit`. Core checks these limits before saving the reply. `SendInput.chunkCount` identifies the final part when a platform requires one combined response.

Return `pending` with `retryAfterMs` when a prepared reply is waiting for the platform to collect it, such as a WeCom callback refresh. The worker defers the same part without using a failure attempt or recording delivery. Return `sent` only after the channel observes the platform handoff. Use failure results for actual failures; waiting for an external callback must not exhaust delivery retries.

Each configured account gets its own channel instance. Keep credentials out of message context, reply destinations and logs. If the platform needs connection state or sequence numbers, use the host's state store so that restarting does not lose them.

Core supplies `host.boundChatIds` from this account's bindings. Connection channels can use it to subscribe to configured conversations; IRC uses it to join channels without a separate channel list. Use `host.publicUrl` for your deployment's public address.

### Native text and image layouts

Declare `capabilities.richText` only when the native protocol accepts ordered text/image content. Its `maxParts` counts text and image parts per chunk; `maxTextLength` limits their aggregate source text using `lengthUnit`. Optional `imageMimeTypes` and `maxImageBytes` restrict inline images. Core sends an image outside those inline limits through standalone media delivery at its original position, once. Normal media and whole-message limits still apply.

Core resolves the Markdown references documented in [Ordered Markdown media](media.md#ordered-markdown-media), checks channel ownership and image kinds, splits balanced text and freezes the delivery plan before enqueueing. `DeliveryChunk.richText` contains ordered `RichTextPart` text/image entries and is mutually exclusive with nonempty `text` and standalone `media`. `SendInput.richMedia` supplies the verified stored images in reading order. Match those bytes to the chunk references and use your platform's native upload or image URL representation; do not fetch the internal Markdown URI. Persist any native upload IDs needed across retries in the channel's state.

Channels without `richText` receive ordered text and standalone media chunks. WeCom HTTP collects one final text-then-images reply, and IRC rejects attachments. `host.status()` exposes the resulting `richText` mode and, for native layouts, `richTextLimits`. Local protocol coverage must verify the actual native payload and any inline-image fallback without claiming live-account compatibility.

## Extend an agent

Authenticate requests before obtaining an Agent host scoped to the allowed endpoint IDs. `host.status()` lists channels from the current authorized bindings, including native send availability and limits. Incoming data carries `source.channel` and `source.senderId`. Public send and media tools use the channel ID; internal incoming request IDs remain useful for event deduplication and notification recovery.

Send with `sendMessage({ channel, text, idempotencyKey?, attachments? })`, using `source.channel.id` or a channel returned by status. Sending does not require an incoming message. Each call without a key creates a new send; reuse an explicit key only for the same send intent with identical text and ordered attachments. The returned `queued` result means the message was saved for sending. `host.status({ deliveryId })` returns the delivery only while its channel remains authorized.

Attachments can refer to received or uploaded media in the selected channel, or contain newly generated bytes. `host.media.authorize({ channelId })` checks access before issuing an upload capability; `host.media.upload({ channelId, mediaId, upload })` saves an immutable channel-owned asset. `host.media.read({ channelId, mediaId })` reads available bytes. Storage rechecks current ownership, previews and outstanding upload quotas in the write transaction. Enqueueing releases the referenced uploads from the staging quota; each message has its own media limits. Uploading does not enqueue a message. Pass the returned ID to `sendMessage` afterward. See [Media transfer](../media.md) and the exported SDK types for attachment shapes.

Register agent HTTP routes through the host beneath `/agents/<agentId>`. Keep endpoint credentials separate from the fields exposed in notifications and tool responses. dot and Grok already share MCP authentication and message tools in `packages/agent-mcp`; reuse those helpers when changing their integration.

## Store channels and deliveries

Core registers configured conversations through `registerConversations` before setting up integrations. Storage retains authenticated native targets independently of incoming messages. `enqueueMessage` authorizes the channel and saves the endpoint, resolved destination and rendered parts together. Outbound FIFO and explicit idempotency keys are scoped to the channel.

`getMessageReceipt` and immutable `media.getReference` metadata let an authorized keyed retry return an existing delivery after media bytes have been cleaned. They do not make cleaned media readable or usable for a new send. Keep unfinished deliveries and referenced media intact during cleanup.

## Embed Core

When calling `createCore` directly, `worker` accepts only `maxMediaBytes`, `maxTotalMediaBytes` and `maxAttachments`. Scheduling, retry, lease and request budgets use internal defaults. The CLI exposes the same attachment controls as top-level `mediaLimits`. In the CLI configuration, omit `relay.observability` to use standard logs and metrics, or provide an explicit observability configuration to override them.

## Check the integration

Exercise authentication, sender restrictions, event replay, reply destinations, media limits and failure recovery through the public interfaces. Use local HTTP or socket peers for platform responses and a real database for recovery. Include the test rationale described in [Contributing](../development.md).

Keep the channel guide useful to the person setting it up: document the platform credentials, required permissions, callback address, supported media and limits. Cite primary platform documentation when introducing protocol behavior. Record any live-account checks separately from local tests so users can tell what was verified.
