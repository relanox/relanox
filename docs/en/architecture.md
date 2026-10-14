# How messages reach your agent

Relanox connects your messaging accounts to an existing dot or Grok Bot. Each bound conversation or thread is an authorized channel. Incoming messages identify their source channel, and the Agent sends messages to a channel it can access.

## Follow a message

1. **You send a message.** The channel connection receives text and supported attachments from the platform.
2. **Relanox checks who may use the agent.** The sender must be on the account's allowlist. The conversation must have a binding to an agent; a thread needs its own matching binding. An optional binding allowlist can narrow access further.
3. **Relanox saves the message.** Text, attachments, the source channel and the receiving Agent are saved in SQLite or PostgreSQL before Core confirms acceptance. The same platform event arriving again is recognized as a duplicate.
4. **Optional middleware prepares the message.** Configured middleware runs in order before forwarding. The speech plugin can append recognized text; original messages and attachments remain intact. Without middleware, this step does no work.
5. **Your Agent is notified.** Relanox sends the message, its source channel and attachment information to dot or Grok. The Agent can read the attachments and prepare an answer in its own service.
6. **The Agent sends to a channel.** It selects the source channel or another authorized channel from `relanox_status`, then submits text or supported media. Relanox saves an independent delivery, splits long text to fit the platform, then sends it and records the result.

The Agent can also send to an authorized channel before receiving a message, where the native platform permits it. `relanox_status` lists the available channels and explains missing native context or expired send windows. The Agent can send a progress update followed by a final answer where the channel permits multiple replies. WeCom HTTP callback permits one reply per incoming message, so send only the final answer in that mode. After receiving your question, it takes time to prepare a response and send it back to the conversation. See [Message status and recovery](reference/core.md) if a reply is delayed.

## What happens after a restart?

Saved work stays in the configured database. When Relanox starts again, it resumes messages waiting for notification or delivery. Keep the SQLite file on persistent storage, or use a persistent PostgreSQL database.

Keep Relanox running so it can receive new messages. After an interruption, check its connection status and resend any questions that still need an answer.

## Where will an old message be sent?

Received messages keep their selected Agent endpoint. Each queued delivery separately keeps its destination and endpoint. Changing a binding does not redirect those queued deliveries. New sends use the current bindings: removing or reassigning a channel removes the former Agent's access to it and its media.

Channel IDs are generated from the binding and Agent endpoint. Use the ID from current status or incoming `source.channel.id`; do not construct one from a message ID. Changing endpoint ownership or configuration can change the channel ID. After rotating a credential under the same bot identity, update its environment variable and restart the service; saved deliveries use the updated credential.

## What do I need to run?

Prepare a computer or server to run Relanox and an available dot or Grok Bot. Start with SQLite to store data in a local file, or connect to PostgreSQL. Some channels need a public HTTPS address for webhooks or media downloads; others connect outward to the platform. Each [channel guide](channels/index.md) explains its requirements.

Both cloud Agents need a publicly reachable HTTPS address for MCP, including with outbound channels.

The service has a separate local management address for health checks and metrics. Keep that address private. Message contents and credentials are excluded from the standard operational logs; administrative commands can show message content only when you ask for it.

Start with [Quick start](getting-started.md), then use [Configuration](configuration.md), [Media transfer](media.md) and [Operations](operations.md) for deployment details. If you are contributing an integration, see [Build an integration](reference/sdk.md).
