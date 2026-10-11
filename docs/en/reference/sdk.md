# Adding an integration

This guide is for contributors adding a native messaging integration or extending an agent integration. If you only want to connect a supported account, use its [channel guide](../channels/index.md) and [Configuration](../configuration.md); you do not need to use the SDK.

## Start with the public SDK

`@relanox/sdk` provides the types used by channels, agents and storage. Its public entrypoint is `packages/sdk/src/index.ts`. Use the exported types and an existing integration with a similar transport as your starting point. See [Contributing](../development.md) for installation and checks.

A channel integration receives platform events and sends replies. An agent integration authenticates an agent, notifies it of inputs, and accepts its replies. Relanox supplies each integration with a scoped host that saves messages and checks access. Use that host rather than opening the database directly.

## Add a channel

1. Define and validate the account configuration. Require environment references for secrets; validation should check values without making network calls.
2. Authenticate incoming platform events, extract a stable event ID, and pass text, supported attachments and conversation information to the channel host. Wait for the host to save the input before acknowledging the platform event.
3. Declare platform text limits and supported media kinds. Relanox splits text before sending; your adapter handles native uploads and downloads.
4. Implement sending for one prepared message part at a time. Preserve its send identity across retries, report the platform receipt on success, and distinguish a known temporary failure from an uncertain result.
5. Register any webhook handlers through the host. The application owns listening addresses and mounts channel routes under `/channels/<accountId>`.

For channels with a limited reply budget, declare `capabilities.maxChunksPerMessage`. Core rejects a reply that would exceed that number of text chunks before saving it for delivery. WeCom HTTP callback uses `1` because its reply URL accepts one reply; keep this separate from the per-chunk text limit.

Each configured account gets its own channel instance. Keep credentials out of message context, reply destinations and logs. If the platform needs connection state or sequence numbers, use the host's state store so that restarting does not lose them.

Core supplies `host.boundChatIds` from this account's bindings. Connection channels can use it to subscribe to configured conversations; IRC uses it to join channels without a separate channel list. Use `host.publicUrl` for your deployment's public address.

## Extend an agent

Authenticate requests before obtaining an agent host scoped to the allowed endpoint IDs. The agent can read attachments for an authorized input and send replies using that input's `replyTo`; it cannot provide an arbitrary destination.

A reply call uses `sendMessage({ replyTo, text, idempotencyKey?, attachments? })`. Reuse an explicit key when retrying a call, and use different keys for intentional repeated replies. The returned `queued` result means the reply was saved for sending.

Attachments can refer to received media or contain newly generated media bytes. Respect the target channel's formats and limits. See [Media transfer](../media.md) and the exported SDK types for the supported attachment shapes.

Register agent HTTP routes through the host beneath `/agents/<agentId>`. Keep endpoint credentials separate from the fields exposed in notifications and tool responses. dot and Grok already share MCP authentication and message tools in `packages/agent-mcp`; reuse those helpers when changing their integration.

## Embed Core

When calling `createCore` directly, `worker` accepts only `maxMediaBytes`, `maxTotalMediaBytes` and `maxAttachments`. Scheduling, retry, lease and request budgets use internal defaults. The CLI exposes the same attachment controls as top-level `mediaLimits`. In the CLI configuration, omit `relay.observability` to use standard logs and metrics, or provide an explicit observability configuration to override them.

## Check the integration

Exercise authentication, sender restrictions, event replay, reply destinations, media limits and failure recovery through the public interfaces. Use local HTTP or socket peers for platform responses and a real database for recovery. Include the test rationale described in [Contributing](../development.md).

Keep the channel guide useful to the person setting it up: document the platform credentials, required permissions, callback address, supported media and limits. Cite primary platform documentation when introducing protocol behavior. Record any live-account checks separately from local tests so users can tell what was verified.
