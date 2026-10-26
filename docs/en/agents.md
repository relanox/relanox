# Hosted agents

Relanox connects existing hosted dot, Grok and Muse agents. Each endpoint has its
own MCP route, credential and conversation scope. An account is usable only after
an exact conversation binding has been configured.

## dot

```sh
relanox agent add --id dot --agent dot
```

The endpoint uses OAuth over HTTPS and native MCP Events. Add the printed
`https://relay.example.com/agents/dot/mcp/dot` URL in the host's connector settings.
The generated MCP credential is the login password for this OAuth endpoint, not a
bearer token. Its file location and environment override
are printed after setup. Keep the native event subscription's instructions bound
to the exact incoming request.

The endpoint uses the [official MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)
for MCP and the [Standard Webhooks Go library](https://github.com/standard-webhooks/standard-webhooks/tree/libraries/v0.0.1/libraries/go)
for event signatures. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
requires protocol version `2026-07-28`; event subscriptions remain persistent across
restarts and must be renewed before their granted expiration.

## Grok

```sh
relanox agent add --id grok --agent grok
```

Use Grok Bot in the Cursor account that owns the Bot and its MCP connections.
Create a webhook-triggered Routine in that application, then supply
the Routine URL and complete Authorization header value at the prompts. Relanox
POSTs the native notification envelope to that URL. Configure the printed MCP URL
with its generated bearer credential so the Routine can read messages and send
replies. The optional native configuration `mcp.auth = "path"` is also supported;
the CLI prints a `<token>` placeholder instead of exposing that credential.

Cursor documents the [Routine webhook contract](https://cursor.com/help/grok-bot/routines#where-do-the-webhook-url-and-key-live-and-what-does-a-200-mean)
as an HTTP POST with `Authorization: Bearer <key>` and a JSON body. Only HTTP `200`
confirms that a run started; this does not confirm a final reply. A lost transport
response remains unknown. Relanox calls the Routine webhook over HTTP with a
10-second timeout and propagates the caller's cancellation. The MCP connection
uses the official MCP Go SDK.

## Muse

```sh
relanox agent add --id muse --agent muse --credentials-directory paired/muse
```

Complete device pairing with the [official Muse gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux)
workflow first. Point this command at the resulting directory containing `pairing.json`, `identity.json` and,
when present, `sdk_token`. The directory is an ordinary path relative to the
Relanox configuration, not a secret reference. It must remain writable so refreshed
credentials can be saved. Relanox uses the paired device's native encrypted
transport, VM/session selection and hosted MCP connection.

Optional `vmId` and `sessionId` can select a specific target through a native JSON
option file. The CLI imports an existing pairing. Stop the SDK daemon before
using its paired directory with Relanox, and give each independently running deployment
its own pairing; concurrent clients can consume rotating refresh tokens. Changing
or revoking the SDK token used for pairing requires pairing again.

The upstream device SDK targets Python on Linux and C on ESP32. Relanox uses
[`flynn/noise`](https://github.com/flynn/noise) for the native Noise XX handshake
and AES-GCM state, with Muse-specific framing and account operations adapted
from the official SDK. Notifications contain text and attachment metadata; media
travels through the scoped MCP tools. Local checks compare fixed bytes produced
by the official SDK and exercise encrypted HTTP/WebSocket traffic. They do not
establish live Muse account compatibility.

## Requests, replies and media

The shared tools are `relanox_read_messages`, `relanox_status` and
`relanox_send_message`. A new notification identifies its exact `requestId`.
Replies must carry `{ "requestId": "...", "kind": "final" }` for the request being
answered. A progress reply uses `kind = "progress"` and does not complete it.
Streaming replies are outside the supported scope.

Reads and media operations recheck the endpoint's current conversation ownership.
The durable queue retains the endpoint captured when the message was accepted,
so changing a binding cannot silently reroute previously accepted work. Private
native reply targets and credential references do not appear in the agent's
message data.

Media can be received and sent according to each native channel's capabilities.
Use the MCP tool's advertised schema and media references. Status reports native
text limits, media kinds, rich text support and current availability. A completed
enqueue means the reply is durable; a native send can still fail or become unknown.
